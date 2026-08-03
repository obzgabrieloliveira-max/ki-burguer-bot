@echo off
cd /d "%~dp0"
echo.
echo [1/4] Verificando sintaxe...
node --check server.js
if errorlevel 1 (
  echo ERRO: server.js com erro de sintaxe.
  pause
  exit /b 1
)

echo [2/4] Instalando dependencias...
call npm install
if errorlevel 1 (
  echo ERRO ao instalar dependencias.
  pause
  exit /b 1
)

echo [3/4] Preparando Git...
git add server.js package.json render.yaml .env.example .gitignore README.md
git commit -m "Migrar bot para Apollo Gateway"
if errorlevel 1 (
  echo Nenhuma alteracao nova para enviar.
  pause
  exit /b 1
)

echo [4/4] Enviando para o GitHub...
git push origin main
if errorlevel 1 (
  echo ERRO no git push.
  pause
  exit /b 1
)

echo.
echo Enviado. Aguarde o Render ficar LIVE.
pause
