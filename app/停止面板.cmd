@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist "data\panel.pid" (
  echo 没找到 data\panel.pid —— 面板可能不是用启动器起来的。
  echo 如果是前台窗口模式，直接关那个窗口就行。
  pause
  exit /b 1
)

set /p PANEL_PID=<data\panel.pid
echo 正在结束面板进程 PID=%PANEL_PID%
taskkill /PID %PANEL_PID% /F
del /q "data\panel.pid" 2>nul
del /q "data\panel.port" 2>nul
echo 已停止。
timeout /t 2 >nul
