@echo off
chcp 65001 >nul 2>nul
setlocal enabledelayedexpansion
title A股每日买入计划 · 启动器
cd /d "%~dp0"

rem ============================================================
rem  已有一台服务在跑？直接打开浏览器，不重复启动
rem ============================================================
where curl >nul 2>nul
if not errorlevel 1 (
  curl -s -o nul -m 2 http://127.0.0.1:8765/
  if not errorlevel 1 (
    echo.
    echo  检测到服务已在运行，直接打开浏览器。
    echo.
    start "" "http://127.0.0.1:8765/"
    timeout /t 2 >nul
    exit /b 0
  )
)

echo.
echo  ======================================================
echo    A股每日买入计划 · 正在启动
echo  ======================================================
echo.

rem ---- 优先使用内置 Node ----
set "NODE="
if exist "%~dp0runtime\node.exe" set "NODE=%~dp0runtime\node.exe"
if not defined NODE (
  where node >nul 2>nul
  if not errorlevel 1 set "NODE=node"
)
if defined NODE goto :run_node

rem ---- 退而使用 Python ----
set "PY="
if exist "%~dp0runtime\python.exe" set "PY=%~dp0runtime\python.exe"
if not defined PY (
  where python >nul 2>nul
  if not errorlevel 1 set "PY=python"
)
if defined PY goto :run_py

echo  [错误] 本机未找到 Node.js 或 Python。
echo.
echo  请安装 Node.js（推荐，安装后无需任何配置）：
echo      https://nodejs.org/zh-cn/download
echo  下载 "Windows 安装包 (.msi)" 双击安装即可。
echo.
pause
exit /b 1

:run_node
echo  运行时: Node.js
"%NODE%" "%~dp0server.mjs" %*
goto :done

:run_py
echo  运行时: Python
"%PY%" "%~dp0server.py" %*
goto :done

:done
if errorlevel 1 (
  echo.
  echo  服务异常退出。
  pause
)
endlocal