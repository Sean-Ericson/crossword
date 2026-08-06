' fetch_watch_hidden.vbs - start the request watcher with no console window.
'
' For the no-administrator setup: put a shortcut to this file in your
' Startup folder (press Win+R, run "shell:startup", drop the shortcut in)
' and the watcher starts each time you log in, invisibly.
'
' It writes to logs\fetch.log exactly as fetch_watch.bat does. To stop it,
' end the python.exe process in Task Manager.
Dim shell, here
Set shell = CreateObject("WScript.Shell")
here = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
' 0 = hidden window, False = don't wait for it to finish
shell.Run """" & here & "fetch_watch.bat""", 0, False
