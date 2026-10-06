#ifndef AppVersion
  #define AppVersion "1.2.1"
#endif
#define AppSourceDir "..\release\win-unpacked"

[Setup]
AppId=ai.localis.desktop
AppName=Localis
AppVersion={#AppVersion}
AppPublisher=Localis contributors
DefaultDirName={localappdata}\Programs\Localis
DefaultGroupName=Localis
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
UsePreviousAppDir=yes
Uninstallable=yes
UninstallDisplayIcon={app}\Localis.exe
CloseApplications=force
RestartApplications=no
WizardStyle=modern
Compression=lzma2/fast
SolidCompression=yes
DiskSpanning=no
OutputDir=..\release
OutputBaseFilename=Localis-Setup-{#AppVersion}
VersionInfoVersion={#AppVersion}
VersionInfoProductName=Localis
SetupLogging=yes

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked

[Files]
Source: "{#AppSourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Localis"; Filename: "{app}\Localis.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\Localis"; Filename: "{app}\Localis.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\Localis.exe"; Description: "Launch Localis"; Flags: nowait postinstall skipifsilent
