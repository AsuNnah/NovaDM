; Installer page: choose the shortcuts (both ticked). electron-builder creates them as usual; the
; ones left unticked are removed again right after. Updates and silent installs keep them.
!ifndef BUILD_UNINSTALLER
  !include nsDialogs.nsh
  Var desktopBox
  Var startMenuBox
  Var wantDesktop
  Var wantStartMenu
!endif

!macro customPageAfterChangeDir
  Page custom shortcutsPage shortcutsPageLeave

  Function shortcutsPage
    ${if} ${isUpdated}
      Abort
    ${endIf}
    !insertmacro MUI_HEADER_TEXT "Shortcuts" "Where do you want to start NovaDM from?"
    nsDialogs::Create 1018
    Pop $0
    ${NSD_CreateCheckbox} 0 0 100% 12u "Create a &desktop shortcut"
    Pop $desktopBox
    ${NSD_Check} $desktopBox
    ${NSD_CreateCheckbox} 0 20u 100% 12u "Add NovaDM to the &Start menu"
    Pop $startMenuBox
    ${NSD_Check} $startMenuBox
    nsDialogs::Show
  FunctionEnd

  Function shortcutsPageLeave
    ${NSD_GetState} $desktopBox $wantDesktop
    ${NSD_GetState} $startMenuBox $wantStartMenu
  FunctionEnd
!macroend

!macro customInstall
  ${ifNot} ${isUpdated}
    ${if} $wantDesktop == ${BST_UNCHECKED}
      WinShell::UninstShortcut "$newDesktopLink"
      Delete "$newDesktopLink"
    ${endIf}
    ${if} $wantStartMenu == ${BST_UNCHECKED}
      WinShell::UninstShortcut "$newStartMenuLink"
      Delete "$newStartMenuLink"
    ${endIf}
  ${endIf}
!macroend
