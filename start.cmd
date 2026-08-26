@echo off
setlocal
chcp 65001 >nul
title 语雀 AI 编辑器本地服务

set "YUQUE_AI_PROJECT_WIN=%~dp0"
pushd "%~dp0" 2>nul
if errorlevel 1 (
  echo 无法进入项目目录：%~dp0
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Windows Node.js。请安装 Node.js 20 或更高版本。
  popd
  pause
  exit /b 1
)

node bridge\server.mjs
set "YUQUE_AI_EXIT=%ERRORLEVEL%"
popd
if not "%YUQUE_AI_EXIT%"=="0" (
  echo.
  echo 本地服务异常退出，错误码：%YUQUE_AI_EXIT%
  pause
)
exit /b %YUQUE_AI_EXIT%
