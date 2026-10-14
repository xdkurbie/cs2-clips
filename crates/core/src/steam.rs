//! Match history through the official Steam Web API
//! (`ICSGOPlayers_730/GetNextMatchSharingCode/v1`).
//!
//! Secrets are never logged; error messages never contain the key or auth code.

use crate::sharecode::{self, ShareCode};

pub const API: &str = "https://api.steampowered.com/ICSGOPlayers_730/GetNextMatchSharingCode/v1";

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SteamError {
    #[error("Steam rejected the API key or game authentication code (403)")]
    Forbidden,
    #[error("Steam says the known share code does not belong to this account (412)")]
    UnknownCode,
    #[error("Steam API is rate limiting, try again later (429)")]
    RateLimited,
    #[error("Steam API error (HTTP {0})")]
    Http(u16),
    #[error("network error: {0}")]
    Network(String),
    #[error("Steam returned an unexpected response")]
    BadResponse,
    #[error("missing credentials: {0}")]
    Missing(&'static str),
}

#[derive(Debug, Clone, Default)]
pub struct Credentials {
    pub api_key: String,
    pub steamid64: String,
    pub auth_code: String,
}

impl Credentials {
    pub fn check(&self) -> Result<(), SteamError> {
        if self.api_key.trim().len() != 32 {
            return Err(SteamError::Missing("Steam Web API key (32 characters)"));
        }
        if self.steamid64.trim().len() != 17
            || !self.steamid64.trim().chars().all(|c| c.is_ascii_digit())
        {
            return Err(SteamError::Missing("SteamID64 (17 digits)"));
        }
        if self.auth_code.trim().is_empty() {
            return Err(SteamError::Missing("game authentication code"));
        }
        Ok(())
    }
}

/// Minimal HTTP abstraction so the walker is testable without network.
pub trait HttpGet {
    fn get(&self, url: &str) -> Result<(u16, String), String>;
}

pub struct UreqHttp(ureq::Agent);

impl Default for UreqHttp {
    fn default() -> Self {
        let cfg = ureq::Agent::config_builder()
            .timeout_global(Some(std::time::Duration::from_secs(20)))
            .http_status_as_error(false)
            .build();
        Self(cfg.into())
    }
}

impl HttpGet for UreqHttp {
    fn get(&self, url: &str) -> Result<(u16, String), String> {
        // Strip the query so secrets never end up in an error string.
        let mut r = self
            .0
            .get(url)
            .call()
            .map_err(|e| e.to_string().replace(url, API))?;
        let status = r.status().as_u16();
        let body = r.body_mut().read_to_string().unwrap_or_default();
        Ok((status, body))
    }
}

fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Next share code after `known`, or `None` when there are no newer matches.
pub fn next_code(
    http: &dyn HttpGet,
    c: &Credentials,
    known: &str,
) -> Result<Option<String>, SteamError> {
    let url = format!(
        "{API}?key={}&steamid={}&steamidkey={}&knowncode={}",
        enc(c.api_key.trim()),
        enc(c.steamid64.trim()),
        enc(c.auth_code.trim()),
        enc(known.trim())
    );
    let (status, body) = http.get(&url).map_err(SteamError::Network)?;
    match status {
        200 => {}
        202 => return Ok(None),
        403 => return Err(SteamError::Forbidden),
        412 => return Err(SteamError::UnknownCode),
        429 => return Err(SteamError::RateLimited),
        s => return Err(SteamError::Http(s)),
    }
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|_| SteamError::BadResponse)?;
    match v["result"]["nextcode"].as_str() {
        None | Some("n/a") | Some("") => Ok(None),
        Some(code) if sharecode::is_valid(code) => Ok(Some(code.to_string())),
        Some(_) => Err(SteamError::BadResponse),
    }
}

/// Follow the chain from `last` and return all newer codes (oldest first).
pub fn walk(
    http: &dyn HttpGet,
    c: &Credentials,
    last: &str,
    limit: usize,
) -> Result<Vec<ShareCode>, SteamError> {
    c.check()?;
    if !sharecode::is_valid(last) {
        return Err(SteamError::Missing("a valid latest share code"));
    }
    let mut out = Vec::new();
    let mut cur = last.to_string();
    for _ in 0..limit {
        match next_code(http, c, &cur)? {
            Some(n) => {
                out.push(sharecode::decode(&n).map_err(|_| SteamError::BadResponse)?);
                cur = n;
            }
            None => break,
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct Fake(RefCell<Vec<(u16, String)>>, RefCell<Vec<String>>);
    impl HttpGet for Fake {
        fn get(&self, url: &str) -> Result<(u16, String), String> {
            self.1.borrow_mut().push(url.to_string());
            Ok(self.0.borrow_mut().remove(0))
        }
    }

    fn creds() -> Credentials {
        Credentials {
            api_key: "A".repeat(32),
            steamid64: "76561198000000001".into(),
            auth_code: "AAAA-BBBBB-CCCC".into(),
        }
    }

    const C1: &str = "CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK";

    #[test]
    fn walks_until_no_more() {
        let c2 = sharecode::encode(&ShareCode {
            match_id: 1,
            outcome_id: 2,
            token: 3,
        });
        let f = Fake(
            RefCell::new(vec![
                (200, format!(r#"{{"result":{{"nextcode":"{c2}"}}}}"#)),
                (200, r#"{"result":{"nextcode":"n/a"}}"#.into()),
            ]),
            RefCell::new(vec![]),
        );
        let v = walk(&f, &creds(), C1, 10).unwrap();
        assert_eq!(
            v,
            vec![ShareCode {
                match_id: 1,
                outcome_id: 2,
                token: 3
            }]
        );
        assert!(f.1.borrow()[1].contains(&c2));
    }

    #[test]
    fn maps_errors() {
        let f = Fake(
            RefCell::new(vec![(403, String::new())]),
            RefCell::new(vec![]),
        );
        assert_eq!(walk(&f, &creds(), C1, 10), Err(SteamError::Forbidden));
        let f = Fake(
            RefCell::new(vec![(202, String::new())]),
            RefCell::new(vec![]),
        );
        assert_eq!(walk(&f, &creds(), C1, 10), Ok(vec![]));
        assert!(matches!(
            walk(&f, &Credentials::default(), C1, 1),
            Err(SteamError::Missing(_))
        ));
    }
}
