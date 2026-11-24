; HKM Audio System — NSIS installer hooks.
;
; These macros are textually injected into the Tauri-generated installer.nsi
; (bundle.windows.nsis.installerHooks in tauri.conf.json). PREINSTALL runs
; inside `Section Install` right BEFORE any file is extracted.
;
; WHY THIS EXISTS: the console server is a sidecar child process
; (binaries\hkm-server.exe) that the stock Tauri NSIS template does not know
; about. While an old instance's sidecar is still running, Windows keeps the
; exe file LOCKED and the installer dies with:
;   "Error opening file for writing:
;    C:\Users\...\HKM Audio System\binaries\hkm-server.exe
;    Click Abort / Retry / Ignore"
; Killing it here (before extraction, before the template's own app-running
; check) makes updates and reinstalls silent and conflict-free. The same is
; done on uninstall so the folder removes cleanly.

!macro NSIS_HOOK_PREINSTALL
  ; Bundled console-server sidecar (NOT covered by the template's app check).
  nsExec::Exec 'taskkill /F /IM "hkm-server.exe"'
  Pop $0
  ; Main app binary: the template's Restart-Manager pass handles this too,
  ; but a pre-emptive kill guarantees a silent passive update (never shows
  ; the "app is running" dialog or the file-write error above).
  nsExec::Exec 'taskkill /F /IM "${MAINBINARYNAME}.exe"'
  Pop $0
  ; Give the OS a moment to release the file handles before extraction.
  Sleep 500
!macroend

!macro NSIS_HOOK_POSTINSTALL
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /F /IM "hkm-server.exe"'
  Pop $0
  nsExec::Exec 'taskkill /F /IM "${MAINBINARYNAME}.exe"'
  Pop $0
  Sleep 500
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend
