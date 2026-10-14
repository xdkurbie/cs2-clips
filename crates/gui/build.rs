fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("../../assets/icon.ico");
        res.set("ProductName", "CS2 Clips");
        res.set(
            "FileDescription",
            "CS2 Clips - highlight finder and montage maker",
        );
        let _ = res.compile();
    }
}
