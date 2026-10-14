//! Integration test against a real CS2 demo. Set CS2CLIPS_TEST_DEMO to a .dem
//! path (CI downloads the public test demo from the demoparser repository).
use cs2clips_core::{demo, detect_highlights, rules::Selectivity, HighlightKind, Rules};

#[test]
fn parses_real_demo() {
    let Ok(path) = std::env::var("CS2CLIPS_TEST_DEMO") else {
        eprintln!("CS2CLIPS_TEST_DEMO not set, skipping");
        return;
    };
    let m = demo::parse_demo(path.as_ref(), None).expect("parse");
    assert_eq!(m.map, "de_mirage");
    assert_eq!(m.kills.len(), 73);
    assert_eq!(m.players().len(), 10);
    assert!(m.rounds.len() >= 9);
    let r = Rules {
        selectivity: Selectivity::Low,
        ..Rules::default()
    };
    let hs = detect_highlights(&m, &r, None);
    assert!(hs.iter().any(|h| h.kind == HighlightKind::MultiKill(3)));
    assert!(hs.iter().all(|h| h.end_tick > h.start_tick));
}
