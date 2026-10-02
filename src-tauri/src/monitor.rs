//! Phone monitor: a tiny HTTP server on the local network that shows the shot
//! currently on screen (developed, as the app renders it) plus the recent
//! strip. The UI pushes a JPEG of its own render whenever the picture or the
//! edit settles; phones long-poll `/state.json` and fetch `/frame.jpg` when
//! the frame counter moves. Nothing leaves the LAN and nothing is stored.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{IpAddr, UdpSocket};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

const PORTS: std::ops::Range<u16> = 7878..7898;
const LONG_POLL: Duration = Duration::from_secs(25);
/// A phone that polled within this window counts as a viewer.
const VIEWER_WINDOW: Duration = Duration::from_secs(45);

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Thumb {
    pub name: String,
    /// data: URL (the filmstrip thumbnail the app already has)
    pub src: String,
    pub active: bool,
}

/// What the app is showing right now, minus the pixels.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Shot {
    pub name: String,
    pub meta: String,
    pub index: usize,
    pub total: usize,
    pub thumbs: Vec<Thumb>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    pub active: bool,
    pub url: String,
    pub port: u16,
    pub qr_svg: String,
    pub viewers: usize,
}

#[derive(Default)]
struct Live {
    seq: u64,
    frame_seq: u64,
    frame: Arc<Vec<u8>>,
    shot: Shot,
    viewers: HashMap<IpAddr, Instant>,
    running: bool,
}

struct Shared {
    live: Mutex<Live>,
    cv: Condvar,
}

pub struct Monitor {
    shared: Arc<Shared>,
    server: Arc<Server>,
    thread: Option<JoinHandle<()>>,
    port: u16,
    url: String,
    qr_svg: String,
}

impl Drop for Monitor {
    fn drop(&mut self) {
        {
            let mut live = self.shared.live.lock().unwrap();
            live.running = false;
        }
        self.shared.cv.notify_all();
        self.server.unblock();
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
        log::info!("monitor: stopped");
    }
}

impl Monitor {
    pub fn info(&self) -> MonitorInfo {
        let viewers = {
            let mut live = self.shared.live.lock().unwrap();
            let now = Instant::now();
            live.viewers
                .retain(|_, t| now.duration_since(*t) < VIEWER_WINDOW);
            live.viewers.len()
        };
        MonitorInfo {
            active: true,
            url: self.url.clone(),
            port: self.port,
            qr_svg: self.qr_svg.clone(),
            viewers,
        }
    }

    pub fn publish_frame(&self, jpeg: Vec<u8>) -> u64 {
        let mut live = self.shared.live.lock().unwrap();
        live.frame = Arc::new(jpeg);
        live.frame_seq += 1;
        live.seq += 1;
        let seq = live.seq;
        drop(live);
        self.shared.cv.notify_all();
        seq
    }

    pub fn publish_shot(&self, shot: Shot) -> u64 {
        let mut live = self.shared.live.lock().unwrap();
        live.shot = shot;
        live.seq += 1;
        let seq = live.seq;
        drop(live);
        self.shared.cv.notify_all();
        seq
    }
}

/// The address a phone on the same network can reach us at. Connecting a UDP
/// socket sends nothing; it just makes the OS pick the outbound interface.
fn lan_ip() -> Option<IpAddr> {
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("8.8.8.8:80").ok()?;
    let ip = s.local_addr().ok()?.ip();
    if ip.is_loopback() || ip.is_unspecified() {
        None
    } else {
        Some(ip)
    }
}

pub fn start() -> anyhow::Result<Monitor> {
    let mut bound = None;
    for port in PORTS {
        match Server::http(("0.0.0.0", port)) {
            Ok(s) => {
                bound = Some((s, port));
                break;
            }
            Err(e) => log::debug!("monitor: port {port} busy: {e}"),
        }
    }
    let (server, port) = bound
        .ok_or_else(|| anyhow::anyhow!("no free port between {} and {}", PORTS.start, PORTS.end))?;
    let server = Arc::new(server);
    let ip = lan_ip().ok_or_else(|| {
        anyhow::anyhow!(
            "no network connection: join the same Wi‑Fi as your phone (or a hotspot) first"
        )
    })?;
    let url = match ip {
        IpAddr::V4(v4) => format!("http://{v4}:{port}/"),
        IpAddr::V6(v6) => format!("http://[{v6}]:{port}/"),
    };
    let qr_svg = qrcode::QrCode::new(url.as_bytes())?
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(220, 220)
        .quiet_zone(true)
        .dark_color(qrcode::render::svg::Color("#000000"))
        .light_color(qrcode::render::svg::Color("#ffffff"))
        .build();

    let shared = Arc::new(Shared {
        live: Mutex::new(Live {
            running: true,
            ..Default::default()
        }),
        cv: Condvar::new(),
    });
    let srv = server.clone();
    let sh = shared.clone();
    let thread = std::thread::Builder::new()
        .name("darkroom-monitor".into())
        .spawn(move || {
            while let Ok(req) = srv.recv() {
                if !sh.live.lock().unwrap().running {
                    break;
                }
                let sh = sh.clone();
                std::thread::spawn(move || handle(req, sh));
            }
        })?;
    log::info!("monitor: serving {url}");
    Ok(Monitor {
        shared,
        server,
        thread: Some(thread),
        port,
        url,
        qr_svg,
    })
}

fn header(k: &str, v: &str) -> Header {
    Header::from_bytes(k.as_bytes(), v.as_bytes()).expect("static header")
}

fn query_u64(url: &str, key: &str) -> Option<u64> {
    let q = url.split_once('?')?.1;
    q.split('&')
        .filter_map(|kv| kv.split_once('='))
        .find(|(k, _)| *k == key)
        .and_then(|(_, v)| v.parse().ok())
}

fn handle(req: Request, sh: Arc<Shared>) {
    let url = req.url().to_string();
    let path = url.split('?').next().unwrap_or("/");
    if *req.method() != Method::Get && *req.method() != Method::Head {
        let _ = req.respond(Response::empty(StatusCode(405)));
        return;
    }
    match path {
        "/" | "/index.html" => {
            let r = Response::from_string(PAGE)
                .with_header(header("Content-Type", "text/html; charset=utf-8"))
                .with_header(header("Cache-Control", "no-store"));
            let _ = req.respond(r);
        }
        "/state.json" => {
            let since = query_u64(&url, "since").unwrap_or(0);
            let ip = req.remote_addr().map(|a| a.ip());
            let body = {
                let mut live = sh.live.lock().unwrap();
                if let Some(ip) = ip {
                    live.viewers.insert(ip, Instant::now());
                }
                let deadline = Instant::now() + LONG_POLL;
                while live.running && live.seq <= since {
                    let now = Instant::now();
                    if now >= deadline {
                        break;
                    }
                    let (g, _) = sh.cv.wait_timeout(live, deadline - now).unwrap();
                    live = g;
                }
                serde_json::json!({
                    "seq": live.seq,
                    "frameSeq": live.frame_seq,
                    "name": live.shot.name,
                    "meta": live.shot.meta,
                    "index": live.shot.index,
                    "total": live.shot.total,
                    "thumbs": live.shot.thumbs,
                })
                .to_string()
            };
            let r = Response::from_string(body)
                .with_header(header("Content-Type", "application/json"))
                .with_header(header("Cache-Control", "no-store"));
            let _ = req.respond(r);
        }
        "/frame.jpg" => {
            let frame = sh.live.lock().unwrap().frame.clone();
            if frame.is_empty() {
                let _ = req.respond(Response::empty(StatusCode(404)));
                return;
            }
            let len = frame.len();
            let r = Response::new(
                StatusCode(200),
                vec![
                    header("Content-Type", "image/jpeg"),
                    header("Cache-Control", "no-store"),
                ],
                std::io::Cursor::new(frame.as_slice().to_vec()),
                Some(len),
                None,
            );
            let _ = req.respond(r);
        }
        _ => {
            let _ = req.respond(Response::empty(StatusCode(404)));
        }
    }
}

const PAGE: &str = r##"<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#111111">
<title>Darkroom Monitor</title>
<style>
html,body{margin:0;height:100%;background:#111;color:#ddd;font:14px -apple-system,system-ui,"Segoe UI",sans-serif;-webkit-user-select:none;user-select:none}
body{display:flex;flex-direction:column;height:100dvh;overflow:hidden}
header{display:flex;align-items:center;gap:10px;padding:10px 14px;padding-top:max(10px,env(safe-area-inset-top));background:#171717}
.dot{width:9px;height:9px;border-radius:50%;background:#d33;flex:none}
.dot.on{background:#3c3}
header b{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}
header small{color:#888;flex:none}
main{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;background:#000;position:relative}
main img{max-width:100%;max-height:100%;object-fit:contain;display:block}
.meta{position:absolute;left:0;right:0;bottom:0;padding:22px 14px 8px;font-size:12px;color:#ddd;background:linear-gradient(transparent,rgba(0,0,0,.75));pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.empty{color:#666;text-align:center;padding:24px}
footer{display:flex;gap:6px;overflow-x:auto;padding:8px;padding-bottom:max(8px,env(safe-area-inset-bottom));background:#161616;scrollbar-width:none}
footer::-webkit-scrollbar{display:none}
footer img{height:58px;border-radius:3px;border:2px solid transparent;flex:none;opacity:.6;background:#000}
footer img.on{border-color:#4f8cff;opacity:1}
main.full img{max-width:none;max-height:none}
main.full{overflow:auto;display:block}
</style></head>
<body>
<header><span class="dot" id="dot"></span><b id="name">Darkroom</b><small id="count"></small></header>
<main id="main"><img id="frame" hidden alt=""><div id="empty" class="empty">Waiting for the first shot…<br><small>Keep this phone on the same Wi‑Fi as the computer.</small></div><div class="meta" id="meta"></div></main>
<footer id="strip"></footer>
<script>
(function(){
  var seq=0, frameSeq=0, lastThumbs='';
  var $=function(id){return document.getElementById(id)};
  var sleep=function(ms){return new Promise(function(r){setTimeout(r,ms)})};
  function render(s){
    $('dot').classList.add('on');
    if(s.frameSeq!==frameSeq){
      frameSeq=s.frameSeq;
      if(frameSeq>0){
        var img=new Image();
        img.onload=function(){$('frame').src=img.src;$('frame').hidden=false;$('empty').hidden=true;};
        img.src='/frame.jpg?s='+frameSeq;
      }
    }
    $('name').textContent=s.name||'Darkroom';
    $('count').textContent=s.total?(s.index+' / '+s.total):'';
    $('meta').textContent=s.meta||'';
    var key=JSON.stringify(s.thumbs.map(function(t){return [t.name,t.active,t.src.length]}));
    if(key!==lastThumbs){
      lastThumbs=key;
      var strip=$('strip');
      strip.textContent='';
      s.thumbs.forEach(function(t){var i=new Image();i.src=t.src;i.title=t.name;if(t.active)i.className='on';strip.appendChild(i)});
      var on=strip.querySelector('.on');
      if(on&&on.scrollIntoView) on.scrollIntoView({inline:'center',block:'nearest'});
    }
  }
  async function loop(){
    for(;;){
      try{
        var r=await fetch('/state.json?since='+seq,{cache:'no-store'});
        if(!r.ok) throw new Error(r.status);
        var s=await r.json();
        seq=s.seq;
        render(s);
      }catch(e){
        $('dot').classList.remove('on');
        await sleep(2000);
      }
    }
  }
  document.addEventListener('visibilitychange',function(){ if(!document.hidden){ seq=0; lastThumbs=''; } });
  $('main').addEventListener('dblclick',function(){ $('main').classList.toggle('full'); });
  loop();
})();
</script>
</body></html>
"##;
