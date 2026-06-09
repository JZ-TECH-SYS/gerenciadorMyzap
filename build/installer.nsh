; Migracao perMachine -> perUser do Gerenciador MyZap.
;
; Ate a v1.6.x o app instalava em Program Files (perMachine, exigia admin).
; A partir desta versao a instalacao e por usuario (%LOCALAPPDATA%\Programs,
; sem UAC, updates silenciosos). Este hook detecta uma instalacao antiga
; per-machine (HKLM) e a desinstala antes de instalar a nova — evitando duas
; copias do app no PC do cliente.
;
; Os dados NAO se perdem na migracao: o electron-store fica em %APPDATA% e o
; MyZap local (sessao do WhatsApp, banco) em %LOCALAPPDATA%, fora da pasta de
; instalacao — o uninstall nao toca neles.

!macro customInit
  ; Procura a instalacao antiga per-machine no registro (64 e 32 bits)
  SetRegView 64
  ReadRegStr $0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "UninstallString"
  ReadRegStr $1 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "InstallLocation"
  ${If} $0 == ""
    SetRegView 32
    ReadRegStr $0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "UninstallString"
    ReadRegStr $1 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "InstallLocation"
    SetRegView 64
  ${EndIf}

  ${If} $0 != ""
    DetailPrint "Removendo instalacao antiga (todos os usuarios)..."
    ; O uninstaller per-machine EXIGE elevacao. ExecWait nao dispara UAC
    ; (falha silenciosa com ERROR_ELEVATION_REQUIRED/740) — por isso usamos
    ; ExecShellWait com o verbo "runas", que mostra o UAC uma unica vez.
    ; Se o usuario negar o UAC, seguimos mesmo assim: o app antigo passa a
    ; redirecionar sozinho para a instalacao nova (redirectToPerUserIfInstalled).
    ${If} $1 != ""
      ExecShellWait "runas" "$1\${UNINSTALL_FILENAME}" "/S _?=$1"
      ; com _?= o uninstaller nao consegue se auto-remover: limpa o resto
      Delete "$1\${UNINSTALL_FILENAME}"
      RMDir "$1"
    ${Else}
      ; sem InstallLocation: remove aspas do UninstallString e executa
      StrCpy $2 $0
      StrCpy $3 $2 1
      ${If} $3 == '"'
        StrCpy $2 $2 "" 1
        StrLen $4 $2
        IntOp $4 $4 - 1
        StrCpy $2 $2 $4
      ${EndIf}
      ExecShellWait "runas" "$2" "/S"
    ${EndIf}
  ${EndIf}
!macroend
