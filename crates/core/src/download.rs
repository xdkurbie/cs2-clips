//! Demo download and `.bz2` decompression.

use std::fs::File;
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum DownloadError {
    #[error("demo URL must start with http:// or https://")]
    BadUrl,
    #[error("download failed: {0}")]
    Network(String),
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),
}

/// Decompress (if `.bz2`) a stream into `out`, reporting bytes read through `progress`.
pub fn write_demo<R: Read>(
    input: R,
    compressed: bool,
    out: &Path,
    mut progress: impl FnMut(u64),
) -> Result<PathBuf, DownloadError> {
    let tmp = out.with_extension("part");
    {
        let counting = Counting {
            inner: input,
            n: 0,
            cb: &mut progress,
        };
        let mut w = BufWriter::new(File::create(&tmp)?);
        let res = if compressed {
            io::copy(
                &mut bzip2::read::MultiBzDecoder::new(BufReader::new(counting)),
                &mut w,
            )
        } else {
            io::copy(&mut BufReader::new(counting), &mut w)
        };
        if let Err(e) = res.and_then(|_| w.flush()) {
            let _ = std::fs::remove_file(&tmp);
            return Err(e.into());
        }
    }
    std::fs::rename(&tmp, out)?;
    Ok(out.to_path_buf())
}

/// Decompress a local `.dem.bz2` next to itself.
pub fn decompress_file(path: &Path) -> Result<PathBuf, DownloadError> {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("demo.dem.bz2");
    let out = path.with_file_name(name.trim_end_matches(".bz2"));
    write_demo(File::open(path)?, true, &out, |_| {})
}

struct Counting<'a, R, F: FnMut(u64)> {
    inner: R,
    n: u64,
    cb: &'a mut F,
}

impl<R: Read, F: FnMut(u64)> Read for Counting<'_, R, F> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let k = self.inner.read(buf)?;
        self.n += k as u64;
        (self.cb)(self.n);
        Ok(k)
    }
}

/// Download `url` into `dir` as `<name>.dem`. `progress(read, total)`.
#[cfg(feature = "net")]
pub fn download_demo(
    url: &str,
    dir: &Path,
    name: &str,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<PathBuf, DownloadError> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(DownloadError::BadUrl);
    }
    std::fs::create_dir_all(dir)?;
    let resp = ureq::get(url)
        .call()
        .map_err(|e| DownloadError::Network(e.to_string()))?;
    let total = resp
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok());
    let path_part = url.split('?').next().unwrap_or(url);
    let out = dir.join(format!("{name}.dem"));
    let reader = resp.into_body().into_reader();
    write_demo(reader, path_part.ends_with(".bz2"), &out, |n| {
        progress(n, total)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use bzip2::write::BzEncoder;

    #[test]
    fn decompresses_bz2() {
        let dir = tempfile::tempdir().unwrap();
        let payload = b"PBDEMS2\0 fake demo body".repeat(1000);
        let mut enc = BzEncoder::new(Vec::new(), bzip2::Compression::default());
        enc.write_all(&payload).unwrap();
        let bz = enc.finish().unwrap();
        let src = dir.path().join("m.dem.bz2");
        std::fs::write(&src, &bz).unwrap();
        let out = decompress_file(&src).unwrap();
        assert_eq!(out.file_name().unwrap(), "m.dem");
        assert_eq!(std::fs::read(out).unwrap(), payload);
    }

    #[test]
    fn truncated_bz2_fails_cleanly() {
        let dir = tempfile::tempdir().unwrap();
        let mut enc = BzEncoder::new(Vec::new(), bzip2::Compression::default());
        enc.write_all(&[7u8; 50_000]).unwrap();
        let bz = enc.finish().unwrap();
        let out = dir.path().join("x.dem");
        assert!(write_demo(&bz[..bz.len() / 2], true, &out, |_| {}).is_err());
        assert!(!out.exists() && !out.with_extension("part").exists());
    }
}
