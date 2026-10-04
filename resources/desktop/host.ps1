# ApexDev desktop host: a long-running JSON-lines server driven by src/desktop/host.ts.
# One JSON request per stdin line -> exactly one JSON response line on stdout. All coordinates here are physical pixels.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$utf8 = New-Object System.Text.UTF8Encoding($false)
try { [Console]::InputEncoding = $utf8; [Console]::OutputEncoding = $utf8 } catch { }
$script:stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
$script:stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$script:stdout.AutoFlush = $true
$script:stdout.NewLine = "`n"

$nativeSource = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public class WinInfo {
  public long Hwnd; public string Title; public uint Pid; public string Process;
  public int L, T, R, B; public bool Minimized; public bool Maximized;
}

public static class Native {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }

  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool repaint);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint type);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, StringBuilder l, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);

  public static void InitDpi() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch (Exception) { }
    try { SetProcessDPIAware(); } catch (Exception) { }
  }

  // ---- mouse ----
  static void Send(INPUT[] a) {
    if (a.Length == 0) return;
    SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(INPUT)));
  }
  static INPUT MouseInput(int dx, int dy, uint data, uint flags) {
    INPUT i = new INPUT();
    i.type = 0; i.u.mi.dx = dx; i.u.mi.dy = dy; i.u.mi.mouseData = data; i.u.mi.dwFlags = flags;
    return i;
  }
  public static void MouseMove(int x, int y) {
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
    x = Math.Max(vx, Math.Min(vx + vw - 1, x));
    y = Math.Max(vy, Math.Min(vy + vh - 1, y));
    int nx = (int)Math.Round((x - vx) * 65535.0 / Math.Max(1, vw - 1));
    int ny = (int)Math.Round((y - vy) * 65535.0 / Math.Max(1, vh - 1));
    Send(new INPUT[] { MouseInput(nx, ny, 0, 0x0001 | 0x8000 | 0x4000) });
    Thread.Sleep(4);
    POINT p;
    if (GetCursorPos(out p) && (p.X != x || p.Y != y)) SetCursorPos(x, y);
  }
  public static void MouseButton(string button, bool down) {
    uint f;
    switch (button) {
      case "right": f = down ? 0x0008u : 0x0010u; break;
      case "middle": f = down ? 0x0020u : 0x0040u; break;
      default: f = down ? 0x0002u : 0x0004u; break;
    }
    Send(new INPUT[] { MouseInput(0, 0, 0, f) });
  }
  public static void Wheel(int delta, bool horizontal) {
    Send(new INPUT[] { MouseInput(0, 0, unchecked((uint)delta), horizontal ? 0x1000u : 0x0800u) });
  }
  public static int[] CursorPos() {
    POINT p; GetCursorPos(out p);
    return new int[] { p.X, p.Y };
  }

  // ---- keyboard ----
  static bool IsExtended(int vk) {
    if (vk >= 0x21 && vk <= 0x28) return true;
    switch (vk) {
      case 0x2D: case 0x2E: case 0x5B: case 0x5C: case 0x5D: case 0x6F: case 0x90: case 0xA3: case 0xA5: return true;
    }
    return false;
  }
  static INPUT KeyInput(int vk, bool down) {
    INPUT i = new INPUT();
    i.type = 1; i.u.ki.wVk = (ushort)vk; i.u.ki.wScan = (ushort)MapVirtualKey((uint)vk, 0);
    i.u.ki.dwFlags = (down ? 0u : 2u) | (IsExtended(vk) ? 1u : 0u);
    return i;
  }
  public static void Key(int vk, bool down) { Send(new INPUT[] { KeyInput(vk, down) }); }
  public static void Chord(int[] vks) {
    for (int i = 0; i < vks.Length; i++) { Key(vks[i], true); Thread.Sleep(8); }
    Thread.Sleep(25);
    for (int i = vks.Length - 1; i >= 0; i--) { Key(vks[i], false); Thread.Sleep(8); }
  }
  public static void TypeText(string s) {
    List<INPUT> batch = new List<INPUT>();
    for (int n = 0; n < s.Length; n++) {
      char c = s[n];
      if (c == '\r') { if (n + 1 < s.Length && s[n + 1] == '\n') continue; c = '\n'; }
      if (c == '\n') { batch.Add(KeyInput(0x0D, true)); batch.Add(KeyInput(0x0D, false)); }
      else if (c == '\t') { batch.Add(KeyInput(0x09, true)); batch.Add(KeyInput(0x09, false)); }
      else {
        INPUT d = new INPUT(); d.type = 1; d.u.ki.wScan = c; d.u.ki.dwFlags = 4;
        INPUT u = d; u.u.ki.dwFlags = 4 | 2;
        batch.Add(d); batch.Add(u);
      }
      if (batch.Count >= 40) { Send(batch.ToArray()); batch.Clear(); Thread.Sleep(4); }
    }
    Send(batch.ToArray());
  }

  // ---- windows ----
  static WinInfo Describe(IntPtr h, Dictionary<uint, string> procs) {
    WinInfo w = new WinInfo();
    w.Hwnd = h.ToInt64();
    int len = GetWindowTextLength(h);
    StringBuilder sb = new StringBuilder(len + 2);
    GetWindowText(h, sb, sb.Capacity);
    w.Title = sb.ToString();
    uint pid; GetWindowThreadProcessId(h, out pid);
    w.Pid = pid;
    string name;
    if (procs == null || !procs.TryGetValue(pid, out name)) {
      name = "";
      try { name = Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { }
      if (procs != null) procs[pid] = name;
    }
    w.Process = name;
    RECT r; GetWindowRect(h, out r);
    w.L = r.Left; w.T = r.Top; w.R = r.Right; w.B = r.Bottom;
    w.Minimized = IsIconic(h); w.Maximized = IsZoomed(h);
    return w;
  }
  public static List<WinInfo> ListWindows() {
    List<WinInfo> list = new List<WinInfo>();
    Dictionary<uint, string> procs = new Dictionary<uint, string>();
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h) || GetWindowTextLength(h) == 0) return true;
      try {
        int cloaked = 0;
        if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
      } catch (Exception) { }
      list.Add(Describe(h, procs));
      return true;
    }, IntPtr.Zero);
    return list;
  }
  public static WinInfo Info(long hwnd) {
    IntPtr h = new IntPtr(hwnd);
    if (hwnd == 0 || !IsWindow(h)) return null;
    return Describe(h, null);
  }
  public static long Foreground() { return GetForegroundWindow().ToInt64(); }
  public static bool Exists(long hwnd) { return IsWindow(new IntPtr(hwnd)); }
  public static bool Focus(long hwnd) {
    IntPtr h = new IntPtr(hwnd);
    if (IsIconic(h)) { ShowWindow(h, 9); Thread.Sleep(150); }
    if (GetForegroundWindow() == h) return true;
    for (int attempt = 0; attempt < 2; attempt++) {
      IntPtr fg = GetForegroundWindow();
      uint pid; uint ft = GetWindowThreadProcessId(fg, out pid);
      uint mt = GetCurrentThreadId();
      bool attached = false;
      if (ft != 0 && ft != mt) attached = AttachThreadInput(mt, ft, true);
      if (attempt == 1) { keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero); }
      BringWindowToTop(h);
      SetForegroundWindow(h);
      if (attached) AttachThreadInput(mt, ft, false);
      Thread.Sleep(120);
      if (GetForegroundWindow() == h) return true;
    }
    return GetForegroundWindow() == h;
  }
  public static void Show(long hwnd, int cmd) { ShowWindow(new IntPtr(hwnd), cmd); }
  public static void Close(long hwnd) { PostMessage(new IntPtr(hwnd), 0x0010, IntPtr.Zero, IntPtr.Zero); }
  // Reads the text of a classic Win32 edit control (WM_GETTEXT); null if the window does not answer.
  public static string GetText(long hwnd, int max) {
    IntPtr h = new IntPtr(hwnd);
    IntPtr len;
    if (SendMessageTimeout(h, 0x000E, IntPtr.Zero, IntPtr.Zero, 2, 500, out len) == IntPtr.Zero) return null;
    int n = Math.Min((int)len, max + 1);
    StringBuilder sb = new StringBuilder(n + 2);
    IntPtr copied;
    if (SendMessageTimeout(h, 0x000D, new IntPtr(n + 1), sb, 2, 500, out copied) == IntPtr.Zero) return null;
    return sb.ToString();
  }
  public static void Move(long hwnd, int x, int y, int w, int h) { MoveWindow(new IntPtr(hwnd), x, y, w, h, true); }

  // Grabs a screen rectangle, optionally downscales it to ow x oh and writes a JPEG or PNG file.
  public static void Capture(int x, int y, int w, int h, int ow, int oh, string path, string format, int quality) {
    using (System.Drawing.Bitmap bmp = new System.Drawing.Bitmap(w, h, System.Drawing.Imaging.PixelFormat.Format24bppRgb)) {
      using (System.Drawing.Graphics g = System.Drawing.Graphics.FromImage(bmp)) {
        g.CopyFromScreen(x, y, 0, 0, new System.Drawing.Size(w, h), System.Drawing.CopyPixelOperation.SourceCopy);
      }
      System.Drawing.Bitmap img = bmp;
      try {
        if (ow != w || oh != h) {
          img = new System.Drawing.Bitmap(ow, oh, System.Drawing.Imaging.PixelFormat.Format24bppRgb);
          using (System.Drawing.Graphics g2 = System.Drawing.Graphics.FromImage(img)) {
            g2.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
            g2.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
            g2.DrawImage(bmp, 0, 0, ow, oh);
          }
        }
        if (format == "png") { img.Save(path, System.Drawing.Imaging.ImageFormat.Png); return; }
        System.Drawing.Imaging.ImageCodecInfo codec = null;
        foreach (System.Drawing.Imaging.ImageCodecInfo c in System.Drawing.Imaging.ImageCodecInfo.GetImageEncoders()) {
          if (c.MimeType == "image/jpeg") codec = c;
        }
        System.Drawing.Imaging.EncoderParameters ep = new System.Drawing.Imaging.EncoderParameters(1);
        ep.Param[0] = new System.Drawing.Imaging.EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
        img.Save(path, codec, ep);
      } finally {
        if (img != bmp) img.Dispose();
      }
    }
  }
}
'@
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition $nativeSource -Language CSharp -ReferencedAssemblies System.Drawing
[Native]::InitDpi()
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function ConvertTo-WinObject($w) {
  if ($null -eq $w) { return $null }
  return [ordered]@{
    hwnd = $w.Hwnd; title = $w.Title; process = $w.Process; pid = [int]$w.Pid
    x = $w.L; y = $w.T; w = ($w.R - $w.L); h = ($w.B - $w.T)
    minimized = $w.Minimized; maximized = $w.Maximized
  }
}

function Get-Active {
  $fg = [Native]::Foreground()
  if ($fg -eq 0) { return $null }
  return [Native]::Info($fg)
}

function Get-Arg($a, $name, $default = $null) {
  if ($null -eq $a) { return $default }
  $p = $a.PSObject.Properties[$name]
  if ($null -eq $p -or $null -eq $p.Value) { return $default }
  return $p.Value
}

# Finds a window by 'active', hwnd (number or numeric string) or title/process substring.
function Resolve-Window($spec) {
  if ($null -eq $spec -or "$spec" -eq '' -or "$spec" -eq 'active') {
    $a = Get-Active
    if ($null -eq $a) { throw 'There is no active window.' }
    return $a
  }
  $text = "$spec".Trim()
  if ($text -match '^(0x[0-9a-fA-F]+|\d+)$') {
    $n = [long]$text
    if ([Native]::Exists($n)) { return [Native]::Info($n) }
  }
  $all = [Native]::ListWindows()
  $needle = $text.ToLowerInvariant()
  foreach ($w in $all) { if ($w.Title.ToLowerInvariant() -eq $needle) { return $w } }
  foreach ($w in $all) { if ($w.Title.ToLowerInvariant().Contains($needle)) { return $w } }
  foreach ($w in $all) { if ($w.Process.ToLowerInvariant() -eq $needle -or $w.Process.ToLowerInvariant() -eq ($needle -replace '\.exe$', '')) { return $w } }
  foreach ($w in $all) { if ($w.Process.ToLowerInvariant().Contains($needle)) { return $w } }
  $titles = ($all | Select-Object -First 15 | ForEach-Object { '"' + $_.Title + '"' }) -join ', '
  throw "No visible window matches '$text'. Open windows: $titles"
}

function Get-Monitors {
  $i = 0
  foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
    [ordered]@{ index = $i; primary = [bool]$s.Primary; x = $s.Bounds.X; y = $s.Bounds.Y; w = $s.Bounds.Width; h = $s.Bounds.Height }
    $i++
  }
}

function Select-Monitor($spec) {
  $mons = @(Get-Monitors)
  $key = "$spec".Trim().ToLowerInvariant()
  if ($key -eq '') { $key = 'active' }
  if ($key -eq 'all') {
    $v = [System.Windows.Forms.SystemInformation]::VirtualScreen
    return [ordered]@{ index = -1; primary = $false; x = $v.X; y = $v.Y; w = $v.Width; h = $v.Height }
  }
  if ($key -eq 'primary') { return ($mons | Where-Object { $_.primary } | Select-Object -First 1) }
  if ($key -match '^\d+$') {
    $n = [int]$key
    if ($n -ge $mons.Count) { throw "Monitor $n does not exist (there are $($mons.Count): 0..$($mons.Count - 1))." }
    return $mons[$n]
  }
  $px = $null; $py = $null
  $a = Get-Active
  if ($null -ne $a -and -not $a.Minimized) { $px = [int](($a.L + $a.R) / 2); $py = [int](($a.T + $a.B) / 2) }
  else { $c = [Native]::CursorPos(); $px = $c[0]; $py = $c[1] }
  foreach ($m in $mons) {
    if ($px -ge $m.x -and $px -lt ($m.x + $m.w) -and $py -ge $m.y -and $py -lt ($m.y + $m.h)) { return $m }
  }
  return ($mons | Where-Object { $_.primary } | Select-Object -First 1)
}

function Cmd-Screenshot($a) {
  $maxSize = [int](Get-Arg $a 'maxSize' 1366)
  $path = Get-Arg $a 'path'
  if (-not $path) { throw 'path is required.' }
  $mon = Select-Monitor (Get-Arg $a 'monitor' 'active')
  $x = [int]$mon.x; $y = [int]$mon.y; $w = [int]$mon.w; $h = [int]$mon.h
  $region = Get-Arg $a 'region'
  if ($null -ne $region) {
    $rl = [Math]::Max($mon.x, [int][Math]::Floor([double]$region.x))
    $rt = [Math]::Max($mon.y, [int][Math]::Floor([double]$region.y))
    $rr = [Math]::Min($mon.x + $mon.w, [int][Math]::Ceiling([double]$region.x + [double]$region.w))
    $rb = [Math]::Min($mon.y + $mon.h, [int][Math]::Ceiling([double]$region.y + [double]$region.h))
    if ($rr - $rl -lt 2 -or $rb - $rt -lt 2) { throw 'The requested region is empty or outside the monitor.' }
    $x = $rl; $y = $rt; $w = $rr - $rl; $h = $rb - $rt
  }
  $scale = [Math]::Min(1.0, $maxSize / [double][Math]::Max($w, $h))
  $iw = [int][Math]::Max(1, [Math]::Round($w * $scale)); $ih = [int][Math]::Max(1, [Math]::Round($h * $scale))
  [Native]::Capture($x, $y, $w, $h, $iw, $ih, [string]$path, 'jpeg', 80)
  $c = [Native]::CursorPos()
  return [ordered]@{
    path = $path; monitor = $mon.index; x = $x; y = $y; w = $w; h = $h
    imageWidth = $iw; imageHeight = $ih; scale = ($iw / [double]$w)
    monitors = @(Get-Monitors)
    active = (ConvertTo-WinObject (Get-Active))
    cursor = [ordered]@{ x = $c[0]; y = $c[1] }
  }
}

function Cmd-State($a) {
  $c = [Native]::CursorPos()
  return [ordered]@{
    monitors = @(Get-Monitors)
    active = (ConvertTo-WinObject (Get-Active))
    cursor = [ordered]@{ x = $c[0]; y = $c[1] }
  }
}

function Cmd-Windows($a) {
  $fg = [Native]::Foreground()
  $list = New-Object System.Collections.ArrayList
  foreach ($w in [Native]::ListWindows()) {
    $o = ConvertTo-WinObject $w
    $o['active'] = ($w.Hwnd -eq $fg)
    [void]$list.Add($o)
  }
  return [ordered]@{ windows = $list.ToArray() }
}

function Cmd-Focus($a) {
  $w = Resolve-Window (Get-Arg $a 'window')
  $ok = [Native]::Focus($w.Hwnd)
  return [ordered]@{ focused = $ok; window = (ConvertTo-WinObject (Get-Active)); requested = (ConvertTo-WinObject $w) }
}

function Cmd-WindowAction($a) {
  $w = Resolve-Window (Get-Arg $a 'window')
  $action = [string](Get-Arg $a 'action')
  switch ($action) {
    'minimize' { [Native]::Show($w.Hwnd, 6) }
    'maximize' { [Native]::Show($w.Hwnd, 3) }
    'restore' { [Native]::Show($w.Hwnd, 9) }
    'close' { [Native]::Close($w.Hwnd) }
    'move' {
      if ($w.Minimized -or $w.Maximized) { [Native]::Show($w.Hwnd, 9); Start-Sleep -Milliseconds 150; $w = [Native]::Info($w.Hwnd) }
      $nx = [int](Get-Arg $a 'x' $w.L); $ny = [int](Get-Arg $a 'y' $w.T)
      $nw = [int](Get-Arg $a 'w' ($w.R - $w.L)); $nh = [int](Get-Arg $a 'h' ($w.B - $w.T))
      [Native]::Move($w.Hwnd, $nx, $ny, $nw, $nh)
    }
    default { throw "Unknown window action '$action'." }
  }
  Start-Sleep -Milliseconds 250
  $after = [Native]::Info($w.Hwnd)
  return [ordered]@{ window = (ConvertTo-WinObject $after); closed = ($null -eq $after) }
}

function Get-ModifierList($a) {
  $mods = @()
  $m = Get-Arg $a 'modifiers'
  if ($null -ne $m) { foreach ($v in @($m)) { $mods += [int]$v } }
  return , $mods
}

function Cmd-Click($a) {
  $x = [int][Math]::Round([double]$a.x); $y = [int][Math]::Round([double]$a.y)
  $button = [string](Get-Arg $a 'button' 'left')
  $mods = Get-ModifierList $a
  try {
    foreach ($vk in $mods) { [Native]::Key($vk, $true); Start-Sleep -Milliseconds 10 }
    [Native]::MouseMove($x, $y); Start-Sleep -Milliseconds 40
    [Native]::MouseButton($button, $true); Start-Sleep -Milliseconds 20; [Native]::MouseButton($button, $false)
    if (Get-Arg $a 'double' $false) {
      Start-Sleep -Milliseconds 60
      [Native]::MouseButton($button, $true); Start-Sleep -Milliseconds 20; [Native]::MouseButton($button, $false)
    }
  } finally {
    for ($i = $mods.Count - 1; $i -ge 0; $i--) { [Native]::Key($mods[$i], $false) }
  }
  Start-Sleep -Milliseconds 120
  return [ordered]@{ x = $x; y = $y; active = (ConvertTo-WinObject (Get-Active)) }
}

function Cmd-Move($a) {
  $x = [int][Math]::Round([double]$a.x); $y = [int][Math]::Round([double]$a.y)
  [Native]::MouseMove($x, $y)
  return [ordered]@{ x = $x; y = $y }
}

function Cmd-Drag($a) {
  $fx = [double]$a.fromX; $fy = [double]$a.fromY; $tx = [double]$a.toX; $ty = [double]$a.toY
  [Native]::MouseMove([int][Math]::Round($fx), [int][Math]::Round($fy)); Start-Sleep -Milliseconds 60
  [Native]::MouseButton('left', $true); Start-Sleep -Milliseconds 120
  try {
    $steps = 25
    for ($i = 1; $i -le $steps; $i++) {
      $t = $i / [double]$steps
      [Native]::MouseMove([int][Math]::Round($fx + ($tx - $fx) * $t), [int][Math]::Round($fy + ($ty - $fy) * $t))
      Start-Sleep -Milliseconds 10
    }
    Start-Sleep -Milliseconds 100
  } finally { [Native]::MouseButton('left', $false) }
  Start-Sleep -Milliseconds 120
  return [ordered]@{ ok = $true }
}

function Cmd-Scroll($a) {
  $x = [int][Math]::Round([double]$a.x); $y = [int][Math]::Round([double]$a.y)
  $amount = [int][Math]::Round([double]$a.amount)
  $horizontal = [bool](Get-Arg $a 'horizontal' $false)
  [Native]::MouseMove($x, $y); Start-Sleep -Milliseconds 40
  $n = [Math]::Min(100, [Math]::Abs($amount)); $sign = [Math]::Sign($amount)
  for ($i = 0; $i -lt $n; $i++) { [Native]::Wheel($sign * 120, $horizontal); Start-Sleep -Milliseconds 15 }
  Start-Sleep -Milliseconds 150
  return [ordered]@{ x = $x; y = $y; notches = ($sign * $n) }
}

function Cmd-Type($a) {
  $text = [string](Get-Arg $a 'text' '')
  [Native]::TypeText($text)
  Start-Sleep -Milliseconds 100
  return [ordered]@{ typed = $text.Length; active = (ConvertTo-WinObject (Get-Active)) }
}

function Cmd-Keys($a) {
  $repeat = [int](Get-Arg $a 'repeat' 1)
  $chords = @(Get-Arg $a 'chords')
  for ($r = 0; $r -lt $repeat; $r++) {
    foreach ($c in $chords) {
      [Native]::Chord([int[]]@($c))
      Start-Sleep -Milliseconds 40
    }
  }
  Start-Sleep -Milliseconds 150
  return [ordered]@{ active = (ConvertTo-WinObject (Get-Active)) }
}

function Cmd-ClipboardGet($a) {
  for ($i = 0; $i -lt 6; $i++) {
    try {
      $text = ''
      if ([System.Windows.Forms.Clipboard]::ContainsText()) { $text = [System.Windows.Forms.Clipboard]::GetText() }
      $formats = @()
      $d = [System.Windows.Forms.Clipboard]::GetDataObject()
      if ($null -ne $d) { $formats = @($d.GetFormats($false)) }
      return [ordered]@{ text = $text; hasText = ($text.Length -gt 0); formats = $formats }
    } catch { Start-Sleep -Milliseconds 80 }
  }
  throw 'The clipboard is locked by another application.'
}

function Cmd-ClipboardSet($a) {
  $text = [string](Get-Arg $a 'text' '')
  for ($i = 0; $i -lt 6; $i++) {
    try {
      if ($text.Length -eq 0) { [System.Windows.Forms.Clipboard]::Clear() }
      else { [System.Windows.Forms.Clipboard]::SetDataObject($text, $true, 5, 100) }
      return [ordered]@{ length = $text.Length }
    } catch { Start-Sleep -Milliseconds 80 }
  }
  throw 'The clipboard is locked by another application.'
}

$script:AppCache = $null
$script:AppCacheTime = [DateTime]::MinValue
function Get-AppList {
  if ($null -ne $script:AppCache -and ([DateTime]::Now - $script:AppCacheTime).TotalMinutes -lt 5) { return $script:AppCache }
  $apps = New-Object System.Collections.ArrayList
  $seen = @{}
  $shell = $null
  try { $shell = New-Object -ComObject WScript.Shell } catch { }
  $roots = @((Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'), (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'))
  foreach ($root in $roots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    foreach ($f in (Get-ChildItem -LiteralPath $root -Recurse -Filter *.lnk -File -ErrorAction SilentlyContinue)) {
      $key = $f.BaseName.ToLowerInvariant()
      if ($seen.ContainsKey($key)) { continue }
      $seen[$key] = $true
      $target = ''
      if ($null -ne $shell) { try { $target = [string]$shell.CreateShortcut($f.FullName).TargetPath } catch { } }
      [void]$apps.Add([ordered]@{ name = $f.BaseName; target = $target; launch = $f.FullName; kind = 'shortcut' })
    }
  }
  if (Get-Command Get-StartApps -ErrorAction SilentlyContinue) {
    try {
      foreach ($s in (Get-StartApps)) {
        $key = ([string]$s.Name).ToLowerInvariant()
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        [void]$apps.Add([ordered]@{ name = [string]$s.Name; target = [string]$s.AppID; launch = ('shell:AppsFolder\' + $s.AppID); kind = 'app' })
      }
    } catch { }
  }
  $script:AppCache = $apps.ToArray()
  $script:AppCacheTime = [DateTime]::Now
  return $script:AppCache
}

function Cmd-Apps($a) {
  $q = ([string](Get-Arg $a 'query' '')).Trim().ToLowerInvariant()
  $list = @(Get-AppList | Where-Object { $q -eq '' -or $_.name.ToLowerInvariant().Contains($q) -or $_.target.ToLowerInvariant().Contains($q) })
  $total = $list.Count
  return [ordered]@{ apps = @($list | Select-Object -First 300); total = $total }
}

function Find-App($name) {
  $n = $name.Trim().ToLowerInvariant()
  $all = @(Get-AppList | Where-Object { $_.name -notmatch 'uninstall' })
  $m = @($all | Where-Object { $_.name.ToLowerInvariant() -eq $n })
  if ($m.Count -eq 0) { $m = @($all | Where-Object { $_.name.ToLowerInvariant().StartsWith($n) }) }
  if ($m.Count -eq 0) { $m = @($all | Where-Object { $_.name.ToLowerInvariant().Contains($n) }) }
  if ($m.Count -eq 0) { return $null }
  return ($m | Sort-Object { $_.name.Length } | Select-Object -First 1)
}

function Cmd-Launch($a) {
  $name = ([string](Get-Arg $a 'name' '')).Trim()
  if (-not $name) { throw 'name is required.' }
  $argText = [string](Get-Arg $a 'args' '')
  $wait = [bool](Get-Arg $a 'wait' $true)
  $timeout = [double](Get-Arg $a 'timeout_s' 15)
  $before = @{}
  foreach ($w in [Native]::ListWindows()) { $before[$w.Hwnd] = $true }

  $target = $null; $via = ''
  if ($name -match '^[a-zA-Z][a-zA-Z0-9+.-]+:') { $target = $name; $via = 'url' }
  elseif (Test-Path -LiteralPath $name) { $target = (Resolve-Path -LiteralPath $name).Path; $via = 'path' }
  else {
    $cmd = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Where-Object { $_.Source -match '\.exe$' } | Select-Object -First 1
    if ($null -ne $cmd) { $target = $cmd.Source; $via = 'path-exe' }
    else {
      $app = Find-App $name
      if ($null -ne $app) { $target = $app.launch; $via = "start-menu: $($app.name)" }
    }
  }
  if ($null -eq $target) {
    $hints = @(Get-AppList | Where-Object { $_.name.ToLowerInvariant().Contains($name.ToLowerInvariant().Split(' ')[0]) } | Select-Object -First 8 | ForEach-Object { $_.name })
    $extra = ''
    if ($hints.Count -gt 0) { $extra = ' Similar apps: ' + ($hints -join ', ') + '.' }
    throw "Could not find an app, file or command called '$name'. Use desktop_list_apps to search the installed apps.$extra"
  }

  $sp = @{ FilePath = $target; PassThru = $true }
  if ($argText) { $sp['ArgumentList'] = $argText }
  $proc = Start-Process @sp
  $procId = 0; if ($null -ne $proc) { $procId = $proc.Id }
  if (-not $wait) { return [ordered]@{ launched = $true; via = $via; pid = $procId; window = $null } }

  $found = $null
  $deadline = [DateTime]::Now.AddSeconds($timeout)
  while ([DateTime]::Now -lt $deadline -and $null -eq $found) {
    Start-Sleep -Milliseconds 250
    $new = @([Native]::ListWindows() | Where-Object { -not $before.ContainsKey($_.Hwnd) })
    if ($new.Count -gt 0) {
      $pick = $null
      if ($procId -ne 0) { $pick = $new | Where-Object { $_.Pid -eq $procId } | Select-Object -First 1 }
      if ($null -eq $pick) { $pick = $new[0] }
      $found = $pick
    }
  }
  if ($null -ne $found) {
    Start-Sleep -Milliseconds 500
    $refreshed = [Native]::Info($found.Hwnd)
    if ($null -ne $refreshed) { $found = $refreshed }
  }
  return [ordered]@{ launched = $true; via = $via; pid = $procId; window = (ConvertTo-WinObject $found) }
}

# ---- UI Automation ----
$uiaSource = @'
using System;
using System.Threading;
using System.Windows.Automation;

public static class UiaHelper {
  // Runs a UIA pattern action on a worker thread so a blocking handler (e.g. a modal dialog) cannot hang the host.
  public static string Run(AutomationElement el, string kind, string arg, int waitMs) {
    string err = null;
    Thread t = new Thread(delegate () {
      try {
        switch (kind) {
          case "invoke": ((InvokePattern)el.GetCurrentPattern(InvokePattern.Pattern)).Invoke(); break;
          case "toggle": ((TogglePattern)el.GetCurrentPattern(TogglePattern.Pattern)).Toggle(); break;
          case "select": ((SelectionItemPattern)el.GetCurrentPattern(SelectionItemPattern.Pattern)).Select(); break;
          case "setvalue": ((ValuePattern)el.GetCurrentPattern(ValuePattern.Pattern)).SetValue(arg); break;
          case "expand": {
            ExpandCollapsePattern e = (ExpandCollapsePattern)el.GetCurrentPattern(ExpandCollapsePattern.Pattern);
            if (e.Current.ExpandCollapseState == ExpandCollapseState.Collapsed) e.Expand(); else e.Collapse();
            break;
          }
        }
      } catch (Exception ex) { err = ex.Message; }
    });
    t.IsBackground = true;
    t.Start();
    if (!t.Join(waitMs)) return "pending";
    if (err != null) return "error: " + err;
    return "ok";
  }
}
'@
$uiaRefs = @(
  [System.Windows.Automation.AutomationElement].Assembly.Location,
  [System.Windows.Automation.InvokePattern].Assembly.Location,
  [System.Windows.Automation.ElementNotAvailableException].Assembly.Location
) | Select-Object -Unique
Add-Type -TypeDefinition $uiaSource -Language CSharp -ReferencedAssemblies $uiaRefs

$script:Refs = @{}
$script:NextRef = 1
$AE = [System.Windows.Automation.AutomationElement]

function Add-Ref($el) {
  $id = $script:NextRef
  $script:NextRef++
  $script:Refs[$id] = $el
  if ($script:Refs.Count -gt 4000) {
    foreach ($k in @($script:Refs.Keys)) { if ($k -le ($id - 3000)) { $script:Refs.Remove($k) } }
  }
  return $id
}

function Get-RefElement($id) {
  $n = [int]$id
  if (-not $script:Refs.ContainsKey($n)) { throw "Unknown element ref #$n. Refs come from desktop_ui_tree - call it again to get fresh ones." }
  $el = $script:Refs[$n]
  try { $null = $el.Current.ProcessId } catch { throw "Element #$n no longer exists (the UI changed). Call desktop_ui_tree again." }
  return $el
}

function Test-Pattern($el, $pattern) {
  $obj = $null
  return $el.TryGetCurrentPattern($pattern, [ref]$obj)
}

function Get-ElementValue($el, $typeName, $max) {
  if ($typeName -notin @('Edit', 'Document', 'ComboBox', 'Spinner', 'Slider', 'DataItem', 'Text')) { return $null }
  $obj = $null
  try {
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$obj)) {
      $v = [string]$obj.Current.Value
      if ($v.Length -gt $max) { $v = $v.Substring(0, $max) + '...' }
      return $v
    }
    $obj = $null
    if ($typeName -ne 'Text' -and $el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$obj)) {
      $v = [string]$obj.DocumentRange.GetText($max + 1)
      if ($v.Length -gt $max) { $v = $v.Substring(0, $max) + '...' }
      return $v
    }
    # Classic Win32 edit controls sometimes expose no patterns at all: ask the window directly.
    if ($typeName -in @('Edit', 'Document') -and $el.Current.ClassName -match '^(Edit|RichEdit.*|TextBox)') {
      $h = [long]$el.Current.NativeWindowHandle
      if ($h -ne 0) {
        $v = [Native]::GetText($h, $max)
        if ($null -ne $v) {
          if ($v.Length -gt $max) { $v = $v.Substring(0, $max) + '...' }
          return $v
        }
      }
    }
  } catch { }
  return $null
}

function Get-ElementState($el, $typeName) {
  $states = New-Object System.Collections.ArrayList
  $obj = $null
  try {
    if ($typeName -in @('CheckBox', 'Button', 'SplitButton', 'MenuItem') -and $el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$obj)) {
      [void]$states.Add(('toggle=' + $obj.Current.ToggleState))
    }
    $obj = $null
    if ($typeName -in @('RadioButton', 'TabItem', 'ListItem', 'TreeItem', 'DataItem') -and $el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$obj)) {
      if ($obj.Current.IsSelected) { [void]$states.Add('selected') }
    }
    $obj = $null
    if ($typeName -in @('ComboBox', 'TreeItem', 'MenuItem', 'Expander', 'SplitButton') -and $el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$obj)) {
      [void]$states.Add(('expand=' + $obj.Current.ExpandCollapseState))
    }
  } catch { }
  return $states.ToArray()
}

$script:Interactive = @('Edit', 'Document', 'Button', 'CheckBox', 'ComboBox', 'ListItem', 'MenuItem', 'TabItem', 'Hyperlink', 'Slider', 'RadioButton', 'TreeItem', 'SplitButton', 'Spinner', 'DataItem')

function Cmd-UiTree($a) {
  $w = Resolve-Window (Get-Arg $a 'window' 'active')
  $query = ([string](Get-Arg $a 'query' '')).Trim().ToLowerInvariant()
  $types = @()
  $tv = Get-Arg $a 'types'
  if ($null -ne $tv) { foreach ($t in @($tv)) { $types += ([string]$t).Trim().ToLowerInvariant() } }
  $max = [Math]::Min(400, [Math]::Max(1, [int](Get-Arg $a 'max' 80)))
  $maxDepth = [Math]::Max(1, [int](Get-Arg $a 'depth' 12))
  if ($w.Minimized) { [Native]::Show($w.Hwnd, 9); Start-Sleep -Milliseconds 300 }

  $cr = New-Object System.Windows.Automation.CacheRequest
  foreach ($p in @($AE::NameProperty, $AE::ControlTypeProperty, $AE::AutomationIdProperty, $AE::BoundingRectangleProperty, $AE::IsEnabledProperty, $AE::HasKeyboardFocusProperty, $AE::IsOffscreenProperty, $AE::ClassNameProperty)) { $cr.Add($p) }
  $cr.TreeScope = [System.Windows.Automation.TreeScope]::Element
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $root = $AE::FromHandle([IntPtr]$w.Hwnd)

  $out = New-Object System.Collections.ArrayList
  $state = @{ visited = 0; truncated = $false; deadline = [DateTime]::Now.AddSeconds(25) }
  # Iterative pre-order DFS (document order).
  $stack = New-Object System.Collections.Stack
  $first = $walker.GetFirstChild($root, $cr)
  $kids = New-Object System.Collections.ArrayList
  while ($null -ne $first) { [void]$kids.Add($first); $first = $walker.GetNextSibling($first, $cr) }
  for ($i = $kids.Count - 1; $i -ge 0; $i--) { $stack.Push(@($kids[$i], 1)) }

  while ($stack.Count -gt 0) {
    if ($out.Count -ge $max) { $state.truncated = $true; break }
    if ($state.visited -ge 6000 -or [DateTime]::Now -gt $state.deadline) { $state.truncated = $true; break }
    $item = $stack.Pop()
    $el = $item[0]; $depth = [int]$item[1]
    $state.visited++
    $c = $el.Cached
    if ($c.IsOffscreen) { continue }
    $typeName = $c.ControlType.ProgrammaticName -replace '^ControlType\.', ''
    if ($typeName -eq 'Pane' -and ([string]$c.ClassName) -match '^(Edit|RichEdit.*|TextBox)$') { $typeName = 'Edit' }
    $name = [string]$c.Name
    $autoId = [string]$c.AutomationId
    $rect = $c.BoundingRectangle

    if ($depth -lt $maxDepth) {
      $ch = $walker.GetFirstChild($el, $cr)
      $list = New-Object System.Collections.ArrayList
      while ($null -ne $ch) { [void]$list.Add($ch); $ch = $walker.GetNextSibling($ch, $cr) }
      for ($i = $list.Count - 1; $i -ge 0; $i--) { $stack.Push(@($list[$i], ($depth + 1))) }
    }

    if ($rect.IsEmpty -or [double]::IsInfinity($rect.Width) -or $rect.Width -le 0 -or $rect.Height -le 0) { continue }
    if ($types.Count -gt 0 -and ($typeName.ToLowerInvariant() -notin $types)) { continue }
    $value = Get-ElementValue $el $typeName 300
    if ($query -ne '') {
      $hay = ($name + "`n" + $autoId + "`n" + [string]$value + "`n" + [string]$c.ClassName).ToLowerInvariant()
      if (-not $hay.Contains($query)) { continue }
    } elseif ($types.Count -eq 0) {
      if ($name -eq '' -and $autoId -eq '' -and [string]$value -eq '' -and ($typeName -notin $script:Interactive)) { continue }
    }
    $nameOut = $name; if ($nameOut.Length -gt 200) { $nameOut = $nameOut.Substring(0, 200) + '...' }
    $ref = Add-Ref $el
    [void]$out.Add([ordered]@{
      ref = $ref; type = $typeName; name = $nameOut; value = $value; automationId = $autoId
      enabled = [bool]$c.IsEnabled; focused = [bool]$c.HasKeyboardFocus; state = @(Get-ElementState $el $typeName)
      x = [int][Math]::Round($rect.X); y = [int][Math]::Round($rect.Y); w = [int][Math]::Round($rect.Width); h = [int][Math]::Round($rect.Height)
      depth = $depth
    })
  }
  return [ordered]@{ window = (ConvertTo-WinObject $w); elements = $out.ToArray(); visited = $state.visited; truncated = $state.truncated }
}

function Get-ElementCenter($el) {
  $r = $el.Current.BoundingRectangle
  if ($r.IsEmpty -or [double]::IsInfinity($r.Width) -or $r.Width -le 0 -or $r.Height -le 0) { return $null }
  return @([int][Math]::Round($r.X + $r.Width / 2), [int][Math]::Round($r.Y + $r.Height / 2))
}

function Invoke-PhysicalClick($el) {
  $center = Get-ElementCenter $el
  if ($null -eq $center) { throw 'The element has no on-screen position (it may be hidden or scrolled out of view).' }
  [Native]::MouseMove($center[0], $center[1]); Start-Sleep -Milliseconds 40
  [Native]::MouseButton('left', $true); Start-Sleep -Milliseconds 20; [Native]::MouseButton('left', $false)
}

function Cmd-UiClick($a) {
  $el = Get-RefElement $a.ref
  $method = $null
  $patterns = @(
    @('invoke', [System.Windows.Automation.InvokePattern]::Pattern),
    @('toggle', [System.Windows.Automation.TogglePattern]::Pattern),
    @('select', [System.Windows.Automation.SelectionItemPattern]::Pattern),
    @('expand', [System.Windows.Automation.ExpandCollapsePattern]::Pattern)
  )
  if ($el.Current.IsEnabled) {
    foreach ($p in $patterns) {
      if (-not (Test-Pattern $el $p[1])) { continue }
      $r = [UiaHelper]::Run($el, $p[0], $null, 2500)
      if ($r -eq 'ok') { $method = $p[0]; break }
      if ($r -eq 'pending') { $method = $p[0] + ' (still running - the app may have opened a dialog)'; break }
    }
  }
  if ($null -eq $method) { Invoke-PhysicalClick $el; $method = 'mouse click' }
  Start-Sleep -Milliseconds 250
  return [ordered]@{ method = $method; name = [string]$el.Current.Name; active = (ConvertTo-WinObject (Get-Active)) }
}

function Ensure-ForegroundFor($el) {
  $pid2 = [int]$el.Current.ProcessId
  $act = Get-Active
  if ($null -ne $act -and [int]$act.Pid -eq $pid2) { return }
  $target = [Native]::ListWindows() | Where-Object { [int]$_.Pid -eq $pid2 } | Select-Object -First 1
  if ($null -eq $target) { throw 'Could not find the window that owns this element, so typing into it was skipped.' }
  [void][Native]::Focus($target.Hwnd)
  $act = Get-Active
  if ($null -eq $act -or [int]$act.Pid -ne $pid2) { throw 'Could not bring the element''s window to the foreground, so typing into it was skipped.' }
}

function Cmd-UiSetValue($a) {
  $el = Get-RefElement $a.ref
  $text = [string](Get-Arg $a 'text' '')
  $method = $null
  $obj = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$obj) -and -not $obj.Current.IsReadOnly) {
    $r = [UiaHelper]::Run($el, 'setvalue', $text, 4000)
    if ($r -eq 'ok') { $method = 'ValuePattern' }
  }
  if ($null -eq $method) {
    Ensure-ForegroundFor $el
    try { $el.SetFocus() } catch { Invoke-PhysicalClick $el }
    Start-Sleep -Milliseconds 120
    [Native]::Chord([int[]]@(0x11, 0x41)); Start-Sleep -Milliseconds 80
    if ($text.Length -gt 0) { [Native]::TypeText($text) } else { [Native]::Chord([int[]]@(0x2E)) }
    $method = 'focus + ctrl+a + typing'
  }
  Start-Sleep -Milliseconds 200
  $typeName = $el.Current.ControlType.ProgrammaticName -replace '^ControlType\.', ''
  return [ordered]@{ method = $method; value = (Get-ElementValue $el 'Edit' 300); active = (ConvertTo-WinObject (Get-Active)) }
}

# ---- OCR ----
$script:OcrEngine = $null
$script:AsTask = $null
function Initialize-Ocr {
  if ($null -ne $script:OcrEngine) { return }
  try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    [void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
    [void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
    [void][Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime]
    [void][Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
    [void][Windows.Storage.Streams.IRandomAccessStream, Windows.Foundation, ContentType = WindowsRuntime]
    $script:AsTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  } catch {
    throw "OCR is not available on this system: $($_.Exception.Message)"
  }
  if ($null -eq $engine) { throw 'OCR is not available: no OCR language pack is installed for the Windows user-profile languages (Settings > Time & Language > Language).' }
  $script:OcrEngine = $engine
}

function Wait-WinRt($op, [Type]$type) {
  $task = $script:AsTask.MakeGenericMethod($type).Invoke($null, @($op))
  try { if (-not $task.Wait(30000)) { throw 'OCR timed out.' } }
  catch [System.AggregateException] { throw $_.Exception.InnerException.Message }
  return $task.Result
}

function Cmd-Ocr($a) {
  Initialize-Ocr
  $path = [System.IO.Path]::GetFullPath([string](Get-Arg $a 'path'))
  $x = [int]$a.x; $y = [int]$a.y; $w = [int]$a.w; $h = [int]$a.h
  if ($w -lt 2 -or $h -lt 2) { throw 'The OCR area is empty.' }
  [Native]::Capture($x, $y, $w, $h, $w, $h, $path, 'png', 100)
  try {
    $file = Wait-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
    $stream = Wait-WinRt ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Wait-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $sb = Wait-WinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $res = Wait-WinRt ($script:OcrEngine.RecognizeAsync($sb)) ([Windows.Media.Ocr.OcrResult])
    $stream.Dispose()
  } finally { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
  $lines = New-Object System.Collections.ArrayList
  foreach ($line in $res.Lines) {
    $words = New-Object System.Collections.ArrayList
    $minX = [double]::MaxValue; $minY = [double]::MaxValue; $maxX = 0.0; $maxY = 0.0
    foreach ($word in $line.Words) {
      $r = $word.BoundingRect
      [void]$words.Add([ordered]@{ text = $word.Text; x = [int]($x + $r.X); y = [int]($y + $r.Y); w = [int]$r.Width; h = [int]$r.Height })
      $minX = [Math]::Min($minX, $r.X); $minY = [Math]::Min($minY, $r.Y)
      $maxX = [Math]::Max($maxX, $r.X + $r.Width); $maxY = [Math]::Max($maxY, $r.Y + $r.Height)
    }
    if ($words.Count -eq 0) { continue }
    [void]$lines.Add([ordered]@{
      text = $line.Text; x = [int]($x + $minX); y = [int]($y + $minY); w = [int]($maxX - $minX); h = [int]($maxY - $minY)
      words = $words.ToArray()
    })
  }
  return [ordered]@{ language = $script:OcrEngine.RecognizerLanguage.DisplayName; lines = $lines.ToArray() }
}

# ---- main loop ----
function Send-Json($obj) {
  $script:stdout.WriteLine(($obj | ConvertTo-Json -Compress -Depth 10))
}

while ($true) {
  $line = $script:stdin.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  $id = $null
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    $a = $req.args
    $result = switch -Exact ([string]$req.cmd) {
      'ping' { [ordered]@{ pong = $true; ps = $PSVersionTable.PSVersion.ToString(); pid = $PID } }
      'state' { Cmd-State $a }
      'screenshot' { Cmd-Screenshot $a }
      'windows' { Cmd-Windows $a }
      'apps' { Cmd-Apps $a }
      'launch' { Cmd-Launch $a }
      'focus' { Cmd-Focus $a }
      'window' { Cmd-WindowAction $a }
      'ui_tree' { Cmd-UiTree $a }
      'ui_click' { Cmd-UiClick $a }
      'ui_set_value' { Cmd-UiSetValue $a }
      'click' { Cmd-Click $a }
      'move' { Cmd-Move $a }
      'drag' { Cmd-Drag $a }
      'scroll' { Cmd-Scroll $a }
      'type' { Cmd-Type $a }
      'keys' { Cmd-Keys $a }
      'ocr' { Cmd-Ocr $a }
      'clipboard_get' { Cmd-ClipboardGet $a }
      'clipboard_set' { Cmd-ClipboardSet $a }
      default { throw "Unknown command '$($req.cmd)'." }
    }
    Send-Json ([ordered]@{ id = $id; ok = $true; result = $result })
  } catch {
    $msg = [string]$_.Exception.Message
    try { Send-Json ([ordered]@{ id = $id; ok = $false; error = $msg }) } catch { $script:stdout.WriteLine('{"id":null,"ok":false,"error":"host failure"}') }
  }
}
