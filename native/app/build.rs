//! Stages the web files the native app embeds into `dist/` (frontendDist), keeping the repo layout
//! so relative paths in the shared pages (`../shared/…`, `../../assets/icon.png`) keep working.
//! Only these folders are embedded — development scripts and tests stay outside the app.

use std::fs;
use std::path::{Path, PathBuf};

const WEB_DIRS: [&str; 3] = ["src/renderer", "src/shared", "src/native"];
const WEB_FILES: [&str; 1] = ["assets/icon.png"];

fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &to)?;
        } else {
            fs::copy(entry.path(), &to)?;
        }
    }
    Ok(())
}

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"));
    let repo = manifest.join("..").join("..");
    let dist = manifest.join("dist");
    let _ = fs::remove_dir_all(&dist);
    for dir in WEB_DIRS {
        copy_dir(&repo.join(dir), &dist.join(dir)).unwrap_or_else(|e| panic!("staging {dir}: {e}"));
        println!("cargo:rerun-if-changed=../../{dir}");
    }
    for file in WEB_FILES {
        let to = dist.join(file);
        fs::create_dir_all(to.parent().unwrap()).expect("create dist dir");
        fs::copy(repo.join(file), &to).unwrap_or_else(|e| panic!("staging {file}: {e}"));
        println!("cargo:rerun-if-changed=../../{file}");
    }
    tauri_build::build()
}
