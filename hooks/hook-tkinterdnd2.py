from PyInstaller.utils.hooks import collect_data_files
datas = collect_data_files("tkinterdnd2")  # includes the native tkdnd/ binaries + tcl scripts
