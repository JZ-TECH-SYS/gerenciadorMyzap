; Migracao perMachine -> perUser do Gerenciador MyZap.
;
; Ate a v1.6.x o app instalava em Program Files (perMachine, exigia admin).
; A partir desta versao a instalacao e por usuario (%LOCALAPPDATA%\Programs,
; sem UAC, updates silenciosos). Este hook detecta uma instalacao antiga
; per-machine (HKLM) e a remove antes de instalar a nova — evitando duas
; copias do app no PC do cliente.
;
; Tudo acontece num UNICO comando elevado (1 clique de UAC):
;   1. se o uninstaller antigo existir, roda silencioso (start /wait);
;   2. remove a pasta inteira a forca (cobre instalacao MUTILADA — caso real:
;      um uninstall sem elevacao apagou metade dos arquivos e morreu, deixando
;      um app que nem abria e sem uninstaller);
;   3. apaga a entrada orfa de "Adicionar/Remover Programas" (reg 64 e 32).
; Se o usuario negar o UAC, o instalador segue normalmente: o app novo per-user
; funciona do mesmo jeito e a casca antiga (sem atalhos) fica inerte.
;
; Os dados NAO se perdem na migracao: o electron-store fica em %APPDATA% e o
; MyZap local (sessao do WhatsApp, banco) em %LOCALAPPDATA%, fora da pasta de
; instalacao — nada disso e tocado aqui.

!include "FileFunc.nsh"

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

  ; Fallback: registro sem InstallLocation -> deriva da UninstallString
  ${If} $1 == ""
  ${AndIf} $0 != ""
    StrCpy $2 $0
    StrCpy $3 $2 1
    ${If} $3 == '"'
      StrCpy $2 $2 "" 1
      StrLen $4 $2
      IntOp $4 $4 - 1
      StrCpy $2 $2 $4
    ${EndIf}
    ${GetParent} $2 $1
  ${EndIf}

  ${If} $1 != ""
    DetailPrint "Removendo instalacao antiga (todos os usuarios)..."
    ; ExecWait nao dispara UAC (falha com ERROR_ELEVATION_REQUIRED). Um unico
    ; cmd elevado via "runas" faz: uninstall silencioso (se o exe existir) +
    ; remocao forcada da pasta + limpeza da entrada orfa no registro.
    ExecShellWait "runas" "$SYSDIR\cmd.exe" '/c if exist "$1\${UNINSTALL_FILENAME}" (start "" /wait "$1\${UNINSTALL_FILENAME}" /S _?=$1) & rd /s /q "$1" & reg delete "HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" /f /reg:64 & reg delete "HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" /f /reg:32' SW_HIDE
  ${EndIf}
!macroend
