fn main() {
    // Ensure `..\.next\standalone` exists during `cargo check` / `tauri dev`
    // before a full `next build` has been run.
    let _ = std::fs::create_dir_all("../.next/standalone");
    tauri_build::build();
}
