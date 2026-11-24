@echo off
chcp 65001 >nul
title FrishLuna 控制台（前台窗口，关闭此窗口即停止面板）
cd /d "%~dp0"
echo.
echo   FrishLuna 控制台模式
echo   浏览器会自动打开；关掉本窗口即停止面板。
echo.
node server\index.js
echo.
echo   面板已退出。
pause
