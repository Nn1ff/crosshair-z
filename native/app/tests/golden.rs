//! Compositor vs canvas: compositing the per-layer sprites must reproduce the whole-crosshair
//! canvas render (premultiplied BGRA) within 1 per channel. Fixtures come from
//! `node scripts/gen-sprite-fixtures.js`.

use std::fs;
use std::path::PathBuf;

use crosshair_z::overlay::compositor::compose;
use crosshair_z::sprites::codec::SpriteSet;

const TOLERANCE: u32 = 1;
const LEVELS: [(f32, &str); 3] = [(0.0, "0"), (0.5, "50"), (1.0, "100")];

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("golden")
}

fn max_channel_diff(a: u32, b: u32) -> u32 {
    [0u32, 8, 16, 24].iter().map(|s| ((a >> s) & 0xFF).abs_diff((b >> s) & 0xFF)).max().unwrap()
}

#[test]
fn sprites_composite_to_canvas_reference() {
    let index: serde_json::Value = serde_json::from_str(&fs::read_to_string(fixtures_dir().join("index.json")).expect("run scripts/gen-sprite-fixtures.js")).unwrap();
    let entries = index.as_array().unwrap();
    assert!(entries.len() >= 40, "expected the full fixture set");
    let mut failures = Vec::new();
    let mut nonempty = 0;

    for e in entries {
        let id = e["id"].as_str().unwrap();
        let name = e["name"].as_str().unwrap();
        let set = SpriteSet::decode(&fs::read(fixtures_dir().join(format!("{id}.sprite"))).unwrap()).unwrap_or_else(|err| panic!("{name}: {err}"));
        assert_eq!(set.size_px as u64, e["size"].as_u64().unwrap(), "{name}");
        let n = (set.size_px * set.size_px) as usize;
        let mut out = vec![0u32; n];
        for (level, tag) in LEVELS {
            let reference: Vec<u32> = fs::read(fixtures_dir().join(format!("{id}-{tag}.bgra")))
                .unwrap()
                .chunks_exact(4)
                .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                .collect();
            assert_eq!(reference.len(), n, "{name}");
            let levels: Vec<f32> = set.layers.iter().map(|l| if l.fire_speed_ms.is_some() { level } else { 0.0 }).collect();
            compose(&set, &levels, &mut out);
            let worst = out.iter().zip(&reference).map(|(a, b)| max_channel_diff(*a, *b)).max().unwrap_or(0);
            if worst > TOLERANCE {
                failures.push(format!("{name} @ {level}: max channel diff {worst}"));
            }
            if reference.iter().any(|p| *p != 0) {
                nonempty += 1;
            }
        }
    }
    assert!(failures.is_empty(), "golden mismatches:\n{}", failures.join("\n"));
    assert_eq!(nonempty, entries.len() * LEVELS.len(), "every fixture must draw something");
}
