//! Lossless JPEG that uses restart markers.
//!
//! Some DNGs - Samsung's Expert RAW among them - store the picture as a
//! lossless JPEG carrying a restart interval (a DRI marker plus RST markers
//! through the stream). The decoder underneath us ignores those markers, so it
//! loses sync at the first one and its predictor runs away: the picture decays
//! into a smooth gradient a few rows in.
//!
//! A restart marker is exactly the point where the encoder reset its
//! predictor, so each interval is self-contained. Rather than write another
//! JPEG decoder, this splits the stream at its restart markers and hands each
//! interval to the existing decoder as a standalone image, then stacks the
//! results back up. The bands are independent, so they decode in parallel.

use anyhow::{anyhow, bail, Context, Result};
use rawler::decompressors::ljpeg::LjpegDecompressor;
use rayon::prelude::*;
use std::path::Path;

const SOI: u8 = 0xd8;
const EOI: u8 = 0xd9;
const SOF3: u8 = 0xc3;
const DHT: u8 = 0xc4;
const DRI: u8 = 0xdd;
const SOS: u8 = 0xda;

/// A decoded image: interleaved samples, `width * components` per row.
pub struct Decoded {
    pub samples: Vec<u16>,
    pub width: usize,
    pub height: usize,
    pub components: usize,
}

/// The parts of a lossless JPEG needed to rebuild one restart interval.
struct Header<'a> {
    huffman: Vec<&'a [u8]>,
    sof: &'a [u8],
    sos: &'a [u8],
    restart_interval: usize,
    width: usize,
    height: usize,
    components: usize,
    entropy_at: usize,
}

fn be16(b: &[u8], at: usize) -> usize {
    ((b[at] as usize) << 8) | b[at + 1] as usize
}

fn parse_header(b: &[u8]) -> Result<Header<'_>> {
    if b.len() < 4 || b[0] != 0xff || b[1] != SOI {
        bail!("not a JPEG stream");
    }
    let mut huffman = Vec::new();
    let mut sof = None;
    let mut restart_interval = 0;
    let mut i = 2;
    while i + 4 <= b.len() {
        if b[i] != 0xff {
            i += 1;
            continue;
        }
        let marker = b[i + 1];
        if marker == 0xff || marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            i += 2;
            continue;
        }
        let len = be16(b, i + 2);
        if len < 2 || i + 2 + len > b.len() {
            bail!("truncated JPEG segment");
        }
        let seg = &b[i..i + 2 + len];
        match marker {
            DHT => huffman.push(seg),
            SOF3 => sof = Some(seg),
            DRI => restart_interval = be16(b, i + 4),
            SOS => {
                let sof = sof.ok_or_else(|| anyhow!("no lossless frame header"))?;
                if sof.len() < 10 {
                    bail!("short frame header");
                }
                return Ok(Header {
                    huffman,
                    sof,
                    sos: seg,
                    restart_interval,
                    height: be16(sof, 5),
                    width: be16(sof, 7),
                    components: sof[9] as usize,
                    entropy_at: i + 2 + len,
                });
            }
            _ => {}
        }
        i += 2 + len;
    }
    bail!("no scan header")
}

/// Where each restart interval's entropy data starts and ends. A marker is
/// two bytes (0xFF, 0xD0..0xD7) and is not part of either side's data; byte
/// stuffing is 0xFF 0x00, so it can never be mistaken for one.
fn split_at_restarts(b: &[u8], from: usize) -> Vec<(usize, usize)> {
    let mut bands = Vec::new();
    let mut start = from;
    let mut i = from;
    while i + 1 < b.len() {
        if b[i] == 0xff {
            let m = b[i + 1];
            if (0xd0..=0xd7).contains(&m) {
                bands.push((start, i));
                start = i + 2;
                i += 2;
                continue;
            }
            if m == EOI {
                break;
            }
        }
        i += 1;
    }
    bands.push((start, b.len().min(i.max(start))));
    bands
}

/// Rebuild one restart interval as a standalone lossless JPEG.
fn band_jpeg(h: &Header<'_>, data: &[u8], rows: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + 256);
    out.extend_from_slice(&[0xff, SOI]);
    for t in &h.huffman {
        out.extend_from_slice(t);
    }
    let mut sof = h.sof.to_vec();
    sof[5] = (rows >> 8) as u8;
    sof[6] = rows as u8;
    out.extend_from_slice(&sof);
    out.extend_from_slice(h.sos);
    out.extend_from_slice(data);
    out.extend_from_slice(&[0xff, EOI]);
    out
}

/// Decode a lossless JPEG, honouring any restart interval it declares.
pub fn decode(strip: &[u8]) -> Result<Decoded> {
    let h = parse_header(strip)?;
    let per_row = h.width * h.components;
    let mut samples = vec![0u16; per_row * h.height];

    let bands = if h.restart_interval > 0 {
        split_at_restarts(strip, h.entropy_at)
    } else {
        Vec::new()
    };
    // one MCU per pixel at 1x1 sampling, so the interval is a whole number of rows
    let rows_per_band = if h.restart_interval > 0 {
        h.restart_interval / h.width.max(1)
    } else {
        0
    };

    if bands.len() < 2 || rows_per_band == 0 {
        // no restarts: the existing decoder handles the whole stream
        let d = LjpegDecompressor::new(strip).map_err(|e| anyhow!("lossless JPEG: {e}"))?;
        d.decode(&mut samples, 0, per_row, per_row, h.height, false)
            .map_err(|e| anyhow!("lossless JPEG: {e}"))?;
        return Ok(Decoded {
            samples,
            width: h.width,
            height: h.height,
            components: h.components,
        });
    }

    let band_rows = |i: usize| {
        let start = i * rows_per_band;
        if start >= h.height {
            0
        } else {
            rows_per_band.min(h.height - start)
        }
    };
    let errors: Vec<String> = samples
        .par_chunks_mut(rows_per_band * per_row)
        .enumerate()
        .filter_map(|(i, out)| {
            let rows = band_rows(i);
            if rows == 0 {
                return None;
            }
            let (from, to) = match bands.get(i) {
                Some(b) => *b,
                None => return Some(format!("band {i} is missing from the stream")),
            };
            let jpeg = band_jpeg(&h, &strip[from..to], rows);
            let d = match LjpegDecompressor::new(&jpeg) {
                Ok(d) => d,
                Err(e) => return Some(format!("band {i}: {e}")),
            };
            match d.decode(&mut out[..rows * per_row], 0, per_row, per_row, rows, false) {
                Ok(()) => None,
                Err(e) => Some(format!("band {i}: {e}")),
            }
        })
        .collect();
    if let Some(first) = errors.first() {
        bail!("lossless JPEG with restarts: {first}");
    }

    Ok(Decoded {
        samples,
        width: h.width,
        height: h.height,
        components: h.components,
    })
}

// ---------------------------------------------------------------- DNG

/// The image data of a DNG, located without decoding it.
struct Strip {
    offset: usize,
    length: usize,
    width: usize,
    height: usize,
    compression: usize,
    photometric: usize,
}

/// Read the main image's strip out of a DNG. Only the single-strip layout
/// these files use is handled; anything else returns None so the normal
/// decoder keeps the job.
fn find_strip(b: &[u8]) -> Option<Strip> {
    let le = b.starts_with(b"II");
    if !le && !b.starts_with(b"MM") {
        return None;
    }
    let u16at = |o: usize| -> usize {
        if o + 2 > b.len() {
            return 0;
        }
        if le {
            u16::from_le_bytes([b[o], b[o + 1]]) as usize
        } else {
            u16::from_be_bytes([b[o], b[o + 1]]) as usize
        }
    };
    let u32at = |o: usize| -> usize {
        if o + 4 > b.len() {
            return 0;
        }
        if le {
            u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]) as usize
        } else {
            u32::from_be_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]) as usize
        }
    };

    let read_ifd = |at: usize| -> (Vec<(usize, usize, usize, usize)>, Vec<usize>) {
        // (tag, type, count, value-or-offset), and any SubIFD offsets
        let n = u16at(at);
        let mut tags = Vec::with_capacity(n);
        let mut subs = Vec::new();
        for i in 0..n {
            let e = at + 2 + i * 12;
            if e + 12 > b.len() {
                break;
            }
            let tag = u16at(e);
            let typ = u16at(e + 2);
            let count = u32at(e + 4);
            let size = match typ {
                1 | 2 | 6 | 7 => 1,
                3 | 8 => 2,
                4 | 9 | 11 => 4,
                _ => 8,
            } * count;
            let value = if size <= 4 {
                if typ == 3 {
                    u16at(e + 8)
                } else {
                    u32at(e + 8)
                }
            } else {
                u32at(e + 8)
            };
            if tag == 330 {
                let base = if size <= 4 { e + 8 } else { value };
                for k in 0..count {
                    subs.push(u32at(base + k * 4));
                }
            }
            tags.push((tag, typ, count, value));
        }
        (tags, subs)
    };

    let first = u32at(4);
    let (root, subs) = read_ifd(first);
    let mut best: Option<Strip> = None;
    for at in std::iter::once(first).chain(subs.into_iter()) {
        let (tags, _) = if at == first {
            (root.clone(), Vec::new())
        } else {
            read_ifd(at)
        };
        let get = |t: usize| {
            tags.iter()
                .find(|(tag, ..)| *tag == t)
                .map(|(_, _, c, v)| (*c, *v))
        };
        let (Some((_, width)), Some((_, height))) = (get(256), get(257)) else {
            continue;
        };
        let compression = get(259).map(|(_, v)| v).unwrap_or(0);
        let photometric = get(262).map(|(_, v)| v).unwrap_or(0);
        // one strip only: several would need stitching, which these files do not use
        let Some((1, offset)) = get(273) else {
            continue;
        };
        let Some((1, length)) = get(279) else {
            continue;
        };
        let candidate = Strip {
            offset,
            length,
            width,
            height,
            compression,
            photometric,
        };
        if best
            .as_ref()
            .is_none_or(|b| b.width * b.height < width * height)
        {
            best = Some(candidate);
        }
    }
    best
}

/// Decode a linear DNG whose picture is a lossless JPEG with restart markers,
/// which the usual decoder cannot read. Returns None when the file is not that
/// shape, leaving it to the normal path.
pub fn linear_dng_with_restarts(path: &Path) -> Result<Option<Decoded>> {
    let bytes = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
    let Some(strip) = find_strip(&bytes) else {
        return Ok(None);
    };
    // lossless JPEG holding an already demosaiced picture
    if strip.compression != 7 || strip.photometric != 34892 {
        return Ok(None);
    }
    if strip.offset + strip.length > bytes.len() {
        return Ok(None);
    }
    let data = &bytes[strip.offset..strip.offset + strip.length];
    let header = match parse_header(data) {
        Ok(h) => h,
        Err(_) => return Ok(None), // not lossless JPEG after all
    };
    if header.restart_interval == 0 {
        return Ok(None); // no restarts, so the usual decoder copes
    }
    if header.width != strip.width || header.height != strip.height {
        return Ok(None);
    }
    log::info!(
        "linear DNG with restart markers: {}x{}, {} components, restart every {} rows",
        header.width,
        header.height,
        header.components,
        header.restart_interval / header.width.max(1)
    );
    Ok(Some(decode(data)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A lossless JPEG header with a restart interval, and nothing else.
    fn header_bytes(width: usize, height: usize, comps: usize, dri: usize) -> Vec<u8> {
        let mut b = vec![0xff, SOI];
        // DHT (contents are not parsed here, only carried through)
        b.extend_from_slice(&[0xff, DHT, 0x00, 0x05, 0x00, 0x00, 0x00]);
        // DRI
        b.extend_from_slice(&[0xff, DRI, 0x00, 0x04, (dri >> 8) as u8, dri as u8]);
        // SOF3: 8 bytes plus 3 per component
        let sof_len = 8 + 3 * comps;
        b.extend_from_slice(&[0xff, SOF3, (sof_len >> 8) as u8, sof_len as u8, 12]);
        b.extend_from_slice(&[
            (height >> 8) as u8,
            height as u8,
            (width >> 8) as u8,
            width as u8,
            comps as u8,
        ]);
        for c in 0..comps {
            b.extend_from_slice(&[c as u8, 0x11, 0x00]);
        }
        // SOS: 6 bytes plus 2 per component
        let sos_len = 6 + 2 * comps;
        b.extend_from_slice(&[0xff, SOS, (sos_len >> 8) as u8, sos_len as u8, comps as u8]);
        for c in 0..comps {
            b.extend_from_slice(&[c as u8, 0x00]);
        }
        b.extend_from_slice(&[0x01, 0x00, 0x00]);
        b
    }

    #[test]
    fn reads_the_frame_and_restart_interval() {
        let b = header_bytes(4000, 3000, 3, 64000);
        let h = parse_header(&b).unwrap();
        assert_eq!((h.width, h.height, h.components), (4000, 3000, 3));
        assert_eq!(h.restart_interval, 64000);
        assert_eq!(h.restart_interval / h.width, 16, "16 rows per band");
        assert_eq!(h.huffman.len(), 1);
        assert_eq!(h.entropy_at, b.len());
    }

    #[test]
    fn splits_the_stream_at_restart_markers_only() {
        let mut b = header_bytes(4, 8, 1, 4);
        let at = b.len();
        // data, RST0, data, stuffed 0xFF, RST1, data
        b.extend_from_slice(&[1, 2, 3]);
        b.extend_from_slice(&[0xff, 0xd0]);
        b.extend_from_slice(&[4, 5, 0xff, 0x00, 6]);
        b.extend_from_slice(&[0xff, 0xd1]);
        b.extend_from_slice(&[7, 8]);
        b.extend_from_slice(&[0xff, EOI]);
        let bands = split_at_restarts(&b, at);
        assert_eq!(bands.len(), 3, "two markers make three bands");
        assert_eq!(&b[bands[0].0..bands[0].1], &[1, 2, 3]);
        assert_eq!(
            &b[bands[1].0..bands[1].1],
            &[4, 5, 0xff, 0x00, 6],
            "stuffing is not a marker"
        );
        assert_eq!(
            &b[bands[2].0..bands[2].1],
            &[7, 8],
            "stops at the end of image"
        );
    }

    #[test]
    fn a_band_is_rebuilt_as_its_own_image() {
        let b = header_bytes(4000, 3000, 3, 64000);
        let h = parse_header(&b).unwrap();
        let jpeg = band_jpeg(&h, &[9, 9, 9], 16);
        assert_eq!(&jpeg[..2], &[0xff, SOI]);
        assert_eq!(&jpeg[jpeg.len() - 2..], &[0xff, EOI]);
        let rebuilt = parse_header(&jpeg).unwrap();
        assert_eq!(rebuilt.height, 16, "the band's own height");
        assert_eq!(rebuilt.width, 4000);
        assert_eq!(rebuilt.components, 3);
        assert_eq!(rebuilt.huffman.len(), 1, "the tables travel with it");
    }

    #[test]
    fn a_stream_without_restarts_is_left_alone() {
        let b = header_bytes(64, 8, 1, 0);
        let h = parse_header(&b).unwrap();
        assert_eq!(h.restart_interval, 0);
    }
}
