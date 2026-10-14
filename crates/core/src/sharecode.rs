//! Match share codes (`CSGO-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`).
//!
//! A share code packs three numbers (match id, outcome/reservation id and a
//! 16-bit token) into 18 bytes, read as one big-endian integer and written in a
//! base-57 alphabet, least significant digit first.

use num_bigint::BigUint;
use std::fmt;

const ALPHABET: &[u8; 57] = b"ABCDEFGHJKLMNOPQRSTUVWXYZabcdefhijkmnopqrstuvwxyz23456789";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct ShareCode {
    pub match_id: u64,
    pub outcome_id: u64,
    pub token: u16,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ShareCodeError {
    #[error("share code must look like CSGO-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX")]
    Format,
    #[error("invalid character {0:?} in share code")]
    Char(char),
    #[error("share code value out of range")]
    Overflow,
}

fn digit(c: char) -> Option<u32> {
    ALPHABET
        .iter()
        .position(|&a| a as char == c)
        .map(|p| p as u32)
}

/// Cheap syntactic check (prefix, grouping and alphabet).
pub fn is_valid(code: &str) -> bool {
    decode(code).is_ok()
}

pub fn decode(code: &str) -> Result<ShareCode, ShareCodeError> {
    let code = code.trim();
    let body = code.strip_prefix("CSGO-").ok_or(ShareCodeError::Format)?;
    let groups: Vec<&str> = body.split('-').collect();
    if groups.len() != 5 || groups.iter().any(|g| g.chars().count() != 5) {
        return Err(ShareCodeError::Format);
    }
    let mut n = BigUint::from(0u32);
    for c in groups.concat().chars().rev() {
        let d = digit(c).ok_or(ShareCodeError::Char(c))?;
        n = n * 57u32 + d;
    }
    let bytes = n.to_bytes_be();
    if bytes.len() > 18 {
        return Err(ShareCodeError::Overflow);
    }
    let mut b = [0u8; 18];
    b[18 - bytes.len()..].copy_from_slice(&bytes);
    Ok(ShareCode {
        match_id: u64::from_le_bytes(b[0..8].try_into().unwrap()),
        outcome_id: u64::from_le_bytes(b[8..16].try_into().unwrap()),
        token: u16::from_le_bytes(b[16..18].try_into().unwrap()),
    })
}

pub fn encode(sc: &ShareCode) -> String {
    let mut b = Vec::with_capacity(18);
    b.extend_from_slice(&sc.match_id.to_le_bytes());
    b.extend_from_slice(&sc.outcome_id.to_le_bytes());
    b.extend_from_slice(&sc.token.to_le_bytes());
    let mut n = BigUint::from_bytes_be(&b);
    let base = BigUint::from(57u32);
    let mut s = String::with_capacity(29);
    s.push_str("CSGO");
    for i in 0..25 {
        if i % 5 == 0 {
            s.push('-');
        }
        let r = (&n % &base).to_u32_digits().first().copied().unwrap_or(0);
        n /= &base;
        s.push(ALPHABET[r as usize] as char);
    }
    s
}

impl fmt::Display for ShareCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&encode(self))
    }
}

impl std::str::FromStr for ShareCode {
    type Err = ShareCodeError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        decode(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Known vector published alongside the open-source csgo-sharecode tooling.
    const CODE: &str = "CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK";

    #[test]
    fn decodes_known_vector() {
        let sc = decode(CODE).unwrap();
        assert_eq!(sc.match_id, 3_230_642_215_713_767_580);
        assert_eq!(sc.outcome_id, 3_230_647_599_455_273_103);
        assert_eq!(sc.token, 55_788);
    }

    #[test]
    fn round_trips() {
        let sc = decode(CODE).unwrap();
        assert_eq!(encode(&sc), CODE);
        for (m, o, t) in [(0, 0, 0), (1, 2, 3), (u64::MAX, u64::MAX, u16::MAX)] {
            let sc = ShareCode {
                match_id: m,
                outcome_id: o,
                token: t,
            };
            assert_eq!(decode(&encode(&sc)).unwrap(), sc);
        }
    }

    #[test]
    fn rejects_bad_codes() {
        assert_eq!(decode("CSGO-abc"), Err(ShareCodeError::Format));
        assert_eq!(
            decode("XXXX-GADqf-jjyJ8-cSP2r-smZRo-TO2xK"),
            Err(ShareCodeError::Format)
        );
        // 'l', 'I', '0', '1' and 'g' are not in the alphabet
        assert_eq!(
            decode("CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2x0"),
            Err(ShareCodeError::Char('0'))
        );
        assert!(!is_valid(""));
        assert!(is_valid(&format!("  {CODE} ")));
    }
}
