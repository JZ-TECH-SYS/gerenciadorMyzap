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
    ; O uninstaller per-machine pede elevacao (UAC) uma unica vez, nesta
    ; migracao. /S = silencioso; _?= faz o ExecWait esperar de verdade.
    ${If} $1 != ""
      ExecWait '$0 /S _?=$1'
      ; com _?= o uninstaller nao consegue se auto-remover: limpa o resto
      Delete "$1\Uninstall ${PRODUCT_FILENAME}.exe"
      RMDir "$1"
    ${Else}
      ExecWait '$0 /S'
    ${EndIf}
  ${EndIf}
!macroend
