; HKM Audio System — NSIS installer lifecycle hooks.
;
; Runs before and after installation/uninstallation to guarantee that no
; orphaned `hkm-server.exe` or `hkm-audio-system.exe` process holds locks on
; `%LOCALAPPDATA%\HKM Audio System\next-server` or `binaries\hkm-server.exe`
; during an update, reinstall, or uninstall, and cleans out stale `.next`
; chunks so an in-place upgrade never mixes old and new Next.js manifests.

!macro NSIS_HOOK_PREINSTALL
  ; Silently terminate any running HKM server or desktop shell before overwriting files
  nsExec::ExecToLog 'taskkill /F /T /IM "hkm-server.exe"'
  nsExec::ExecToLog 'taskkill /F /IM "${MAINBINARYNAME}.exe"'
  Sleep 800
  ; Wipe stale Next.js standalone build output from any previous version so old
  ; chunk hashes or manifests never collide with the newly extracted version.
  RMDir /r "$INSTDIR\next-server\.next"
  RMDir /r "$INSTDIR\binaries"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Ensure the server binary is marked readable/executable via built-in icacls
  IfFileExists "$INSTDIR\binaries\hkm-server.exe" 0 +2
    nsExec::ExecToLog 'icacls "$INSTDIR\binaries\hkm-server.exe" /grant *S-1-5-32-545:(RX)'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Silently terminate any running HKM server or desktop shell before removing files
  nsExec::ExecToLog 'taskkill /F /T /IM "hkm-server.exe"'
  nsExec::ExecToLog 'taskkill /F /IM "${MAINBINARYNAME}.exe"'
  Sleep 600
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Clean up any lingering next-server runtime cache left in the install dir
  RMDir /r "$INSTDIR\next-server"
  RMDir /r "$INSTDIR\binaries"
!macroend
