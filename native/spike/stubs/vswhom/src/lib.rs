//! Throwaway stub of `vswhom` 0.1.0 for the spike: the real crate compiles C++ (needs cl.exe,
//! missing on this machine). embed-resource only uses it as a last-resort rc.exe lookup, and
//! the spike sets `RC` explicitly in .cargo/config.toml, so "not found" is always correct here.
use std::ffi::OsString;
use std::num::NonZeroU8;

pub struct VsFindResult {
    pub windows_sdk_version: NonZeroU8,
    pub windows_sdk_root: Option<OsString>,
    pub windows_sdk_um_library_path: Option<OsString>,
    pub windows_sdk_ucrt_library_path: Option<OsString>,
    pub vs_exe_path: Option<OsString>,
    pub vs_library_path: Option<OsString>,
}

impl VsFindResult {
    pub fn search() -> Option<VsFindResult> {
        None
    }
}
