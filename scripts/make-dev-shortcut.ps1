param()

$repoRoot = Split-Path -Parent $PSScriptRoot
$cmdPath = Join-Path $repoRoot "simpleSSH-dev.cmd"
$cmdContent = "@echo off`r`ncd /d `"%~dp0`"`r`nnpm run dev`r`n"
Set-Content -Path $cmdPath -Value $cmdContent -Encoding ASCII

$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "SimpleSSH (Dev).lnk"
$iconPath = Join-Path $repoRoot "assets\\icons\\app.ico"
$appId = "com.truedezigner.simplessh.dev"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $cmdPath
$shortcut.WorkingDirectory = $repoRoot
$shortcut.WindowStyle = 7
if (Test-Path $iconPath) {
  $shortcut.IconLocation = $iconPath
}
$shortcut.Description = "SimpleSSH dev launcher"
$shortcut.Save()

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

[ComImport, Guid("00021401-0000-0000-C000-000000000046")]
public class ShellLink { }

[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
public interface IPropertyStore {
  uint GetCount(out uint cProps);
  uint GetAt(uint iProp, out PROPERTYKEY pkey);
  uint GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
  uint SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
  uint Commit();
}

[StructLayout(LayoutKind.Sequential, Pack = 4)]
public struct PROPERTYKEY {
  public Guid fmtid;
  public uint pid;
}

[StructLayout(LayoutKind.Explicit)]
public struct PROPVARIANT {
  [FieldOffset(0)] public ushort vt;
  [FieldOffset(8)] public IntPtr pointerValue;

  public static PROPVARIANT FromString(string value) {
    var pv = new PROPVARIANT();
    pv.vt = 31; // VT_LPWSTR
    pv.pointerValue = Marshal.StringToCoTaskMemUni(value);
    return pv;
  }
}

public static class ShortcutHelper {
  [DllImport("ole32.dll")]
  private static extern int PropVariantClear(ref PROPVARIANT pvar);

  public static void SetAppUserModelId(string shortcutPath, string appId) {
    var shellLink = (IPersistFile)new ShellLink();
    shellLink.Load(shortcutPath, 2);
    var propStore = (IPropertyStore)shellLink;
    var key = new PROPERTYKEY {
      fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"),
      pid = 5
    };
    var pv = PROPVARIANT.FromString(appId);
    propStore.SetValue(ref key, ref pv);
    propStore.Commit();
    PropVariantClear(ref pv);
    shellLink.Save(shortcutPath, true);
  }
}
"@

[ShortcutHelper]::SetAppUserModelId($shortcutPath, $appId)

Write-Host "Created $shortcutPath"
