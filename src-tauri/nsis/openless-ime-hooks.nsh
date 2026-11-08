; Remove the legacy in-process TSF speech provider. It was registered for every
; language, so Windows loaded the DLL into Chromium/Electron hosts such as Feishu.
; New releases use SendInput/clipboard and must never register or ship that DLL.
!define OPENLESS_IME_CLSID "{6B9F3F4F-5EE7-42D6-9C61-9F80B03A5D7D}"

!macro OPENLESS_IME_REMOVE_REGISTRATION
  ; Remove COM and TSF profile state left by older installations in both registry views.
  SetRegView 64
  DeleteRegKey HKLM "Software\Classes\CLSID\${OPENLESS_IME_CLSID}"
  DeleteRegKey HKCU "Software\Classes\CLSID\${OPENLESS_IME_CLSID}"
  DeleteRegKey HKLM "Software\Microsoft\CTF\TIP\${OPENLESS_IME_CLSID}"
  DeleteRegKey HKCU "Software\Microsoft\CTF\TIP\${OPENLESS_IME_CLSID}"
  SetRegView 32
  DeleteRegKey HKLM "Software\Classes\CLSID\${OPENLESS_IME_CLSID}"
  DeleteRegKey HKCU "Software\Classes\CLSID\${OPENLESS_IME_CLSID}"
  DeleteRegKey HKLM "Software\Microsoft\CTF\TIP\${OPENLESS_IME_CLSID}"
  DeleteRegKey HKCU "Software\Microsoft\CTF\TIP\${OPENLESS_IME_CLSID}"
  SetRegView 64
!macroend

!macro OPENLESS_IME_DELETE_LEGACY_FILES
  ; Best-effort cleanup only. A host may keep an old DLL mapped until it exits,
  ; but its TSF registration is already gone. Never request a system reboot just
  ; to remove these optional legacy files.
  ClearErrors
  Delete "$INSTDIR\windows-ime\x64\YanXuIme-*.dll"
  Delete "$INSTDIR\windows-ime\x86\YanXuIme-*.dll"
  Delete "$INSTDIR\windows-ime\x64\OpenLessIme-*.dll"
  Delete "$INSTDIR\windows-ime\x86\OpenLessIme-*.dll"
  Delete "$INSTDIR\windows-ime\x64\OpenLessIme.dll"
  Delete "$INSTDIR\windows-ime\x86\OpenLessIme.dll"
  ClearErrors
  RMDir "$INSTDIR\windows-ime\x64"
  RMDir "$INSTDIR\windows-ime\x86"
  RMDir "$INSTDIR\windows-ime"
  ClearErrors
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro OPENLESS_IME_REMOVE_REGISTRATION
  !insertmacro OPENLESS_IME_DELETE_LEGACY_FILES
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro OPENLESS_IME_REMOVE_REGISTRATION
  !insertmacro OPENLESS_IME_DELETE_LEGACY_FILES
  ; Recreate the all-users desktop shortcut so Windows drops the cached legacy icon.
  IfFileExists "$INSTDIR\yanxu.exe" 0 +3
  Delete "$DESKTOP\言序.lnk"
  CreateShortCut "$DESKTOP\言序.lnk" "$INSTDIR\yanxu.exe" "" "$INSTDIR\yanxu.exe" 0 SW_SHOWNORMAL
  System::Call 'shell32::SHChangeNotify(i 0x00002000, i 0x0005, w "$DESKTOP\言序.lnk", p 0)'
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro OPENLESS_IME_REMOVE_REGISTRATION
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro OPENLESS_IME_REMOVE_REGISTRATION
  !insertmacro OPENLESS_IME_DELETE_LEGACY_FILES
!macroend
