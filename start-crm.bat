@echo off
cd /d "%~dp0"
echo Starting DigiAnchorZ Voice CRM on http://localhost:3000 and http://192.168.1.14:3000 ...
"C:\Program Files\nodejs\node.exe" ".\node_modules\next\dist\bin\next" dev -H 0.0.0.0 -p 3000
pause

