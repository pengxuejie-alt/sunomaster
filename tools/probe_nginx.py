import deploy

client, env = deploy.connect()
command = r"""
ls -la /etc/nginx/sites-enabled /etc/nginx/conf.d
echo ----
grep -R "server_name\|listen " /etc/nginx/sites-enabled /etc/nginx/conf.d -n | head -n 120
echo ----
curl -sI http://127.0.0.1/ | head -n 20
"""
code, out, err = deploy.run_cmd(client, command, env["PASSWORD"], timeout=40)
print(out)
print(err)
print("exit", code)
