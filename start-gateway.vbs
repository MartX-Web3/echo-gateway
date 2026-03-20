Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c cd /d ""C:\Users\user\Documents\Project\echo-protocol\echo-mvp\echo-gateway"" && npm run dev >> ""%USERPROFILE%\.echo\gateway.log"" 2>&1", 0, False
