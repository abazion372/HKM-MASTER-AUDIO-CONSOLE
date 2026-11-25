; HKM Audio System — NSIS installer lifecycle hooks.
;
; Runs before and after installation/uninstallation to guarantee that no
; orphaned `hkm-server.exe`, `hkm-audio-system.exe`, or WebView2 child process
; holds locks on `%LOCALAPPDATA%\HKM Audio System` during an update, reinstall,
; or uninstall, and cleans out stale `.next` chunks so an in-place upgrade
; never mixes old and new Next.js manifests.

!macro NSIS_HOOK_PREINSTALL
  ; Silently terminate the entire process tree (/T) of any running HKM server or desktop shell
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /T /IM "hkm-server.exe"'
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /T /IM "${MAINBINARYNAME}.exe"'
  Sleep 1200

  ; Retry deleting the main binary if Windows Defender or WebView2 takes an extra moment to release the handle
  ClearErrors
  Delete "$INSTDIR\${MAINBINARYNAME}.exe"
  IfErrors 0 +4
    Sleep 1200
    ClearErrors
    Delete "$INSTDIR\${MAINBINARYNAME}.exe"

  ; Wipe stale Next.js standalone build output from any previous version so old
  ; chunk hashes or manifests never collide with the newly extracted version.
  RMDir /r "$INSTDIR\next-server\.next"
  RMDir /r "$INSTDIR\binaries"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Ensure the server binary is marked readable/executable via built-in icacls
  IfFileExists "$INSTDIR\binaries\hkm-server.exe" 0 +2
    nsExec::ExecToLog '"$SYSDIR\icacls.exe" "$INSTDIR\binaries\hkm-server.exe" /grant *S-1-5-32-545:(RX)'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Silently terminate any running HKM server or desktop shell before removing files
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /T /IM "hkm-server.exe"'
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /T /IM "${MAINBINARYNAME}.exe"'
  Sleep 1000
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Clean up any lingering next-server runtime cache left in the install dir
  RMDir /r "$INSTDIR\next-server"
  RMDir /r "$INSTDIR\binaries"
!macroend
