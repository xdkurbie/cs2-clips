//! Persistent settings (`settings.json` in the OS config dir) and secrets
//! (Steam API key / auth code in the OS credential store: Windows Credential
//! Manager, macOS Keychain, Linux keyutils).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub player_name: String,
    pub player_steamid: String,
    /// `.../game/csgo` folder of the CS2 install. Empty = auto-detect.
    pub cs2_dir: String,
    pub steam_exe: String,
    pub ffmpeg: String,
    pub output_dir: String,
    pub rules_file: String,
    pub last_sharecode: String,
    pub capture: CaptureBackend,
    pub obs_host: String,
    pub obs_port: u16,
    pub fps: u32,
    pub resolution: (u32, u32),
    pub hlae_exe: String,
    pub music: String,
    pub transition: String,
    pub slowmo: f32,
    /// Extra demo folders to scan in addition to the CS2 replays folder.
    pub extra_demo_dirs: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum CaptureBackend {
    #[default]
    Ffmpeg,
    Obs,
    Hlae,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            player_name: String::new(),
            player_steamid: String::new(),
            cs2_dir: String::new(),
            steam_exe: if cfg!(windows) {
                r"C:\Program Files (x86)\Steam\steam.exe".into()
            } else {
                String::new()
            },
            ffmpeg: "ffmpeg".into(),
            output_dir: String::new(),
            rules_file: String::new(),
            last_sharecode: String::new(),
            capture: CaptureBackend::Ffmpeg,
            obs_host: "localhost".into(),
            obs_port: 4455,
            fps: 60,
            resolution: (1920, 1080),
            hlae_exe: String::new(),
            music: String::new(),
            transition: "fade".into(),
            slowmo: 1.0,
            extra_demo_dirs: vec![],
        }
    }
}

pub fn project_dirs() -> Option<directories::ProjectDirs> {
    directories::ProjectDirs::from("dev", "xdkurbie", "cs2-clips")
}

pub fn config_dir() -> PathBuf {
    project_dirs()
        .map(|p| p.config_dir().to_path_buf())
        .unwrap_or_else(|| PathBuf::from(".cs2-clips"))
}

pub fn data_dir() -> PathBuf {
    project_dirs()
        .map(|p| p.data_dir().to_path_buf())
        .unwrap_or_else(|| PathBuf::from(".cs2-clips"))
}

impl Settings {
    pub fn path() -> PathBuf {
        config_dir().join("settings.json")
    }

    pub fn load_from(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn load() -> Self {
        Self::load_from(&Self::path())
    }

    pub fn save_to(&self, path: &Path) -> std::io::Result<()> {
        if let Some(p) = path.parent() {
            std::fs::create_dir_all(p)?;
        }
        std::fs::write(path, serde_json::to_string_pretty(self).unwrap())
    }

    pub fn save(&self) -> std::io::Result<()> {
        self.save_to(&Self::path())
    }

    pub fn output_dir(&self) -> PathBuf {
        if self.output_dir.is_empty() {
            directories::UserDirs::new()
                .and_then(|u| u.video_dir().map(|p| p.join("CS2 Clips")))
                .unwrap_or_else(|| data_dir().join("clips"))
        } else {
            PathBuf::from(&self.output_dir)
        }
    }

    /// The CS2 `game/csgo` directory, configured or auto-detected.
    pub fn cs2_game_dir(&self) -> Option<PathBuf> {
        if !self.cs2_dir.is_empty() {
            return Some(PathBuf::from(&self.cs2_dir));
        }
        detect_cs2_dir()
    }

    pub fn demo_dirs(&self) -> Vec<PathBuf> {
        let mut v: Vec<PathBuf> = self
            .cs2_game_dir()
            .map(|d| d.join("replays"))
            .into_iter()
            .collect();
        v.push(data_dir().join("demos"));
        v.extend(self.extra_demo_dirs.iter().map(PathBuf::from));
        v
    }
}

const CS2_REL: &str = "steamapps/common/Counter-Strike Global Offensive/game/csgo";

/// Look in the default Steam locations and every library in `libraryfolders.vdf`.
pub fn detect_cs2_dir() -> Option<PathBuf> {
    let mut roots: Vec<PathBuf> = vec![];
    if cfg!(windows) {
        roots.push(r"C:\Program Files (x86)\Steam".into());
        roots.push(r"C:\Program Files\Steam".into());
    }
    if let Some(u) = directories::BaseDirs::new() {
        roots.push(u.home_dir().join(".steam/steam"));
        roots.push(u.home_dir().join(".local/share/Steam"));
        roots.push(u.home_dir().join("Library/Application Support/Steam"));
    }
    let mut libs = roots.clone();
    for r in &roots {
        if let Ok(vdf) = std::fs::read_to_string(r.join("steamapps/libraryfolders.vdf")) {
            libs.extend(parse_library_paths(&vdf).into_iter().map(PathBuf::from));
        }
    }
    libs.into_iter()
        .map(|l| l.join(CS2_REL))
        .find(|p| p.is_dir())
}

pub fn parse_library_paths(vdf: &str) -> Vec<String> {
    vdf.lines()
        .filter_map(|l| {
            let l = l.trim();
            let rest = l.strip_prefix("\"path\"")?.trim();
            Some(rest.trim_matches('"').replace("\\\\", "\\"))
        })
        .collect()
}

pub mod secrets {
    //! Secrets live in the OS credential store, never in settings.json.
    const SERVICE: &str = "cs2-clips";
    pub const API_KEY: &str = "steam_api_key";
    pub const AUTH_CODE: &str = "steam_auth_code";

    pub fn get(name: &str) -> Option<String> {
        keyring::Entry::new(SERVICE, name)
            .ok()?
            .get_password()
            .ok()
            .filter(|s| !s.is_empty())
    }

    pub fn set(name: &str, value: &str) -> Result<(), String> {
        let e = keyring::Entry::new(SERVICE, name).map_err(|e| e.to_string())?;
        if value.is_empty() {
            match e.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(err) => Err(err.to_string()),
            }
        } else {
            e.set_password(value).map_err(|e| e.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_round_trip_and_tolerate_missing_fields() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("s.json");
        let s = Settings {
            player_name: "rasu420".into(),
            ..Default::default()
        };
        s.save_to(&p).unwrap();
        assert_eq!(Settings::load_from(&p), s);
        std::fs::write(&p, r#"{"player_name":"x"}"#).unwrap();
        assert_eq!(Settings::load_from(&p).fps, 60);
    }

    #[test]
    fn parses_library_vdf() {
        let vdf = "\"libraryfolders\"\n{\n \"0\"\n {\n  \"path\"\t\t\"D:\\\\SteamLibrary\"\n }\n}";
        assert_eq!(
            parse_library_paths(vdf),
            vec!["D:\\SteamLibrary".to_string()]
        );
    }
}
