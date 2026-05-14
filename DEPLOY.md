# DEPLOY — Folder2Page / image-post on Ubuntu 22.04 VPS

Target: Contabo VPS (or any Ubuntu 22.04+ box) running multiple AutoReel
tools side-by-side, each on its own port.

> Your current free ports (avoid 5004–5015 which AutoReel is using):
> **5016, 5017, 5018, …** This guide assumes `imagestool1` on **5016**.

---

## 1. SSH in and update

```bash
ssh root@144.91.75.148
apt update && apt upgrade -y
apt install -y curl git build-essential ufw
```

## 2. Install Node 18 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt install -y nodejs
node --version    # should print v18.x.x
npm --version
```

## 3. Clone the tool

```bash
cd /root
git clone https://github.com/ahmedhasson763-ops/image-post.git imagestool1
cd imagestool1

# Set the port (default is 5016 — change if it conflicts)
echo "PORT=5016" > .env

# Backend deps
npm install

# Frontend deps + build
cd frontend && npm install && npm run build && cd ..
```

## 4. Create the content folder for FileZilla

```bash
mkdir -p /root/imagestool1content
chmod 755 /root/imagestool1content
```

Now in **FileZilla** connect via SFTP to `144.91.75.148:22`, log in as `root`,
and upload your images/videos to `/root/imagestool1content/`.

## 5. Open the port in UFW

```bash
ufw allow 5016/tcp
ufw allow OpenSSH
ufw --force enable
ufw status numbered
```

## 6. Run with systemd (recommended)

```bash
cp scripts/imagestool1.service /etc/systemd/system/imagestool1.service
systemctl daemon-reload
systemctl enable --now imagestool1

# Watch logs in real time:
journalctl -u imagestool1 -f
```

Open <http://144.91.75.148:5016> in your browser.

### Alternative: pm2

```bash
npm install --global pm2
pm2 start scripts/ecosystem.config.js
pm2 save
pm2 startup    # follow the printed command to make pm2 survive reboots
pm2 logs imagestool1
```

## 7. Configure inside the UI

1. **Dashboard** → paste your **long-lived Facebook user access token** →
   Save. It fetches all your pages + business pages automatically.
2. **🤖 AI Captions** →
   - Toggle **Enable AI captions** ON.
   - Pick language (default `🇲🇽 Mexican Spanish`).
   - Set `tool_name` (default `imagestool1` — this drives the default folder
     path `/root/imagestool1content`).
   - Add a niche hint (e.g. *"Mexican street food memes, casual tone"*).
   - Add at least one AI provider. **Recommended fallback chain:**
     1. priority 10 — Gemini `gemini-2.0-flash-exp` (vision)
     2. priority 20 — OpenRouter `google/gemini-2.0-flash-exp:free` (vision)
     3. priority 30 — Groq `llama-3.2-11b-vision-preview` (vision)
     4. priority 99 — Groq `llama-3.3-70b-versatile` (text-only fallback)
   - Hit **🧪 Run test** to verify a caption is generated against a sample image.
   - **💾 Save AI Settings**.
3. **🛡️ Proxy** → paste your proxies (one per line). Either map per page or
   click **Auto-distribute**.
4. **⚙️ Settings** → set gap minutes, rounds, rest, proxies ON/OFF → Save.
5. **🏠 Dashboard** → select pages → confirm content folder
   `/root/imagestool1content` → **🚀 Start**.

## 8. Cloning for a second tool (`imagestool2`, port 5017)

```bash
cd /root
git clone https://github.com/ahmedhasson763-ops/image-post.git imagestool2
cd imagestool2
echo "PORT=5017" > .env
npm install && cd frontend && npm install && npm run build && cd ..
mkdir -p /root/imagestool2content
ufw allow 5017/tcp

# Copy + edit the systemd unit
sed 's/imagestool1/imagestool2/g; s/PORT=5016/PORT=5017/' \
  scripts/imagestool1.service > /etc/systemd/system/imagestool2.service
systemctl daemon-reload
systemctl enable --now imagestool2
```

Then in the UI for tool 2 (`http://144.91.75.148:5017`), change
`tool_name` to `imagestool2` in **🤖 AI Captions** → save.

## 9. Optional: front with Nginx + HTTPS

If you want `https://imagestool1.yourdomain.com` instead of `:5016`:

```bash
apt install -y nginx certbot python3-certbot-nginx

cat > /etc/nginx/sites-available/imagestool1 <<'NGINX'
server {
  listen 80;
  server_name imagestool1.yourdomain.com;
  location / {
    proxy_pass http://127.0.0.1:5016;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 300;
  }
}
NGINX

ln -s /etc/nginx/sites-available/imagestool1 /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d imagestool1.yourdomain.com
```

## 10. Hardening (highly recommended)

```bash
# Disable root password login, use SSH keys only
nano /etc/ssh/sshd_config
#   PermitRootLogin prohibit-password
#   PasswordAuthentication no
systemctl restart ssh

# Restrict the data folder
chmod 700 /root/imagestool1/data

# Rotate the API keys and Facebook token you previously shared in chat.
```

---

## Troubleshooting

- **`Error: listen EADDRINUSE :::5016`** — port already used. Run `ss -tlnp | grep 5016`, change `PORT` in `.env`, `systemctl restart imagestool1`.
- **AI test returns `429`** — that provider hit its free-tier rate limit. Add a second provider in the fallback chain (the engine will route around it automatically).
- **FileZilla uploads end up in `/root/` instead of `/root/imagestool1content`** — in FileZilla, on the right pane double-click `imagestool1content` first to enter it, then drag your files.
- **Posts don't show captions in Spanish** — re-check the Language dropdown in 🤖 AI Captions and run 🧪 Test to verify the language returned by the model.
- **Engine starts but no posts** — check `journalctl -u imagestool1 -f`. Common causes: expired Facebook token (re-paste in Dashboard), no media in the folder, or proxy timing out.
