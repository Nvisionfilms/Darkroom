const OWNER = "Nvisionfilms";
const REPO = "Darkroom";
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;

function githubHeaders(env, accept = "application/vnd.github+json") {
  return {
    Accept: accept,
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Darkroom-Update-Proxy",
  };
}

/**
 * Recent releases, newest first, drafts left out.
 *
 * Asset lookups walk these rather than looking only at the newest release. A
 * release that does not carry a particular file - an APK, say, when the Android
 * job was skipped - then falls through to the one that does, instead of the
 * file simply vanishing the moment anything newer is published.
 */
async function recentReleases(env, count = 10) {
  const response = await fetch(`${API}/releases?per_page=${count}`, {
    headers: githubHeaders(env),
    cf: { cacheTtl: 30, cacheEverything: true },
  });
  if (!response.ok) {
    throw new Error(`GitHub release list failed (${response.status})`);
  }
  const list = await response.json();
  return Array.isArray(list) ? list.filter((r) => !r.draft) : [];
}

async function latestRelease(env) {
  const response = await fetch(`${API}/releases/latest`, {
    headers: githubHeaders(env),
    cf: { cacheTtl: 30, cacheEverything: true },
  });
  if (!response.ok) {
    throw new Error(`GitHub latest release lookup failed (${response.status})`);
  }
  return response.json();
}

async function fetchPrivateAsset(asset, env) {
  return fetch(asset.url, {
    headers: githubHeaders(env, "application/octet-stream"),
    redirect: "follow",
  });
}

function assetNameFromUrl(value) {
  try {
    const path = new URL(value).pathname;
    return decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
  } catch {
    return "";
  }
}

function publicAssetUrl(request, name) {
  const url = new URL(request.url);
  url.pathname = `/darkroom/assets/${encodeURIComponent(name)}`;
  url.search = "";
  return url.toString();
}

async function serveLatestJson(request, env) {
  const release = await latestRelease(env);
  const asset = release.assets?.find((item) => item.name === "latest.json");
  if (!asset) return new Response("Update manifest not found", { status: 404 });

  const response = await fetchPrivateAsset(asset, env);
  if (!response.ok) return new Response("Update manifest unavailable", { status: 502 });

  const manifest = await response.json();
  if (manifest?.platforms && typeof manifest.platforms === "object") {
    for (const platform of Object.values(manifest.platforms)) {
      if (!platform || typeof platform !== "object" || typeof platform.url !== "string") continue;
      const name = assetNameFromUrl(platform.url);
      if (name) platform.url = publicAssetUrl(request, name);
    }
  }

  return Response.json(manifest, {
    headers: {
      "Cache-Control": "public, max-age=30, s-maxage=30",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * What a phone should install, worked out here rather than uploaded by hand.
 *
 * This used to be a file attached to a release, and it went stale the moment
 * anything newer was published without one: the proxy serves the newest
 * release, so the manifest 404'd and the phone reported "status code 404" on
 * every check. Nothing to forget to upload now - the newest release that
 * carries an APK is the answer.
 */
async function serveAndroidJson(request, env) {
  for (const release of await recentReleases(env)) {
    const apk = release.assets?.find((item) => item.name.toLowerCase().endsWith(".apk"));
    if (!apk) continue;
    const version = String(release.tag_name || "").replace(/^v/, "");
    if (!version) continue;
    return Response.json(
      {
        version,
        notes: release.name || `Darkroom ${version}`,
        pub_date: release.published_at || release.created_at || new Date().toISOString(),
        url: publicAssetUrl(request, apk.name),
      },
      {
        headers: {
          "Cache-Control": "public, max-age=30, s-maxage=30",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  }
  return new Response("No Android build has been published yet", { status: 404 });
}

async function serveAsset(request, env, name) {
  let asset = null;
  for (const release of await recentReleases(env)) {
    asset = release.assets?.find((item) => item.name === name);
    if (asset) break;
  }
  if (!asset) return new Response("Update asset not found", { status: 404 });

  const response = await fetchPrivateAsset(asset, env);
  if (!response.ok || !response.body) return new Response("Update asset unavailable", { status: 502 });

  const headers = new Headers();
  headers.set("Content-Type", response.headers.get("Content-Type") || "application/octet-stream");
  headers.set("Content-Disposition", `attachment; filename="${name.replaceAll('"', "")}"`);
  headers.set("Cache-Control", "public, max-age=3600, s-maxage=86400");
  headers.set("X-Content-Type-Options", "nosniff");
  const length = response.headers.get("Content-Length");
  if (length) headers.set("Content-Length", length);
  return new Response(response.body, { status: 200, headers });
}

/** The bundle identifier an Ad Hoc build is signed with. */
const IOS_BUNDLE_ID = "com.nvisi.darkroom";

/** The newest release carrying an .ipa, with its version. */
async function newestIpa(env) {
  for (const release of await recentReleases(env)) {
    const ipa = release.assets?.find((item) => item.name.toLowerCase().endsWith(".ipa"));
    if (!ipa) continue;
    const version = String(release.tag_name || "").replace(/^v/, "");
    if (!version) continue;
    return { release, ipa, version };
  }
  return null;
}

function xmlEscape(value) {
  return String(value).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);
}

/**
 * The install manifest an iPhone reads.
 *
 * An iPhone will not install an app a browser downloaded, the way Android does
 * with an APK. The only way onto the device outside the App Store is Apple's own
 * installer, which is handed an `itms-services:` link naming a plist like this
 * one; the plist in turn names the .ipa. Both have to be plain HTTPS with a
 * valid certificate, which is the whole reason this runs here rather than being
 * a file in the release.
 *
 * The build still has to be signed for the particular iPhone asking: an Ad Hoc
 * profile only installs on the devices whose identifiers were registered when it
 * was made. A phone that is not on the profile gets "Unable to Install" with no
 * further explanation, and nothing served from here can change that.
 */
async function serveIosManifest(request, env) {
  const found = await newestIpa(env);
  if (!found) return new Response("No iPhone build has been published yet", { status: 404 });
  const ipaUrl = publicAssetUrl(request, found.ipa.name);
  const title = found.release.name || `NFrame Studio ${found.version}`;
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
        <dict>
          <key>kind</key>
          <string>software-package</string>
          <key>url</key>
          <string>${xmlEscape(ipaUrl)}</string>
        </dict>
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key>
        <string>${xmlEscape(IOS_BUNDLE_ID)}</string>
        <key>bundle-version</key>
        <string>${xmlEscape(found.version)}</string>
        <key>kind</key>
        <string>software</string>
        <key>title</key>
        <string>${xmlEscape(title)}</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>
`;
  return new Response(body, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=30, s-maxage=30",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * What the iPhone's own update check reads: the same shape as android.json, but
 * the url is the `itms-services:` link rather than a file to download.
 */
async function serveIosJson(request, env) {
  const found = await newestIpa(env);
  if (!found) return new Response("No iPhone build has been published yet", { status: 404 });
  const manifest = new URL(request.url);
  manifest.pathname = "/darkroom/ios-manifest.plist";
  manifest.search = "";
  return Response.json(
    {
      version: found.version,
      notes: found.release.name || `NFrame Studio ${found.version}`,
      pub_date: found.release.published_at || found.release.created_at || new Date().toISOString(),
      url: `itms-services://?action=download-manifest&url=${encodeURIComponent(manifest.toString())}`,
    },
    {
      headers: {
        "Cache-Control": "public, max-age=30, s-maxage=30",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

export default {
  async fetch(request, env) {
    try {
      if (!env.GITHUB_TOKEN) return new Response("Update service is not configured", { status: 503 });
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
      }

      const url = new URL(request.url);
      if (url.pathname === "/darkroom/latest.json") {
        return await serveLatestJson(request, env);
      }

      if (url.pathname === "/darkroom/android.json") {
        return await serveAndroidJson(request, env);
      }

      if (url.pathname === "/darkroom/ios.json") {
        return await serveIosJson(request, env);
      }

      // Apple's installer fetches this one itself, by the url in the link above
      if (url.pathname === "/darkroom/ios-manifest.plist") {
        return await serveIosManifest(request, env);
      }

      const prefix = "/darkroom/assets/";
      if (url.pathname.startsWith(prefix)) {
        const name = decodeURIComponent(url.pathname.slice(prefix.length));
        if (!name || name.includes("/") || name.includes("\\")) return new Response("Not found", { status: 404 });
        // every phone already out there asks for it under the assets path
        if (name === "android.json") return await serveAndroidJson(request, env);
        if (name === "ios.json") return await serveIosJson(request, env);
        return await serveAsset(request, env, name);
      }

      return new Response("Not found", { status: 404 });
    } catch (error) {
      console.error(error);
      return new Response("Update service unavailable", { status: 502 });
    }
  },
};
