# Runbook — Dev Server Setup(Rocky Linux 开发服务器初始化)

> 适用:Rocky Linux 9.x,全新或半新服务器。执行者:具备 sudo 的运维者。预计 1–2 小时。
> ⚠️ 本 runbook 为标准步骤模板;命令在你的环境执行前请逐条确认,尤其涉及 firewalld 与 SSH 配置的部分,**先开第二个 SSH 会话再改 SSH 配置**。

## 1. 系统基线

```bash
sudo dnf update -y
sudo dnf install -y git tmux htop jq tar zip unzip policycoreutils-python-utils

# 专用用户:服务用户 + agent 低权用户
sudo useradd -r -m -d /home/agentplane -s /bin/bash agentplane
sudo useradd -r -m -d /home/agentplane-agent -s /bin/bash agentplane-agent
sudo usermod -aG agentplane agentplane-agent   # agent 入 agentplane 组(细粒度目录权限用)
```

SSH 加固(/etc/ssh/sshd_config):`PasswordAuthentication no`、`PermitRootLogin no`;`sudo systemctl reload sshd`(确认新会话可登后再断旧会话)。
fail2ban:`sudo dnf install -y epel-release && sudo dnf install -y fail2ban && sudo systemctl enable --now fail2ban`。

## 2. 运行时

```bash
# Node 20 + pnpm
sudo dnf module enable -y nodejs:20 && sudo dnf install -y nodejs
sudo npm i -g pnpm

# Docker
sudo dnf config-manager --add-repo https://download.docker.com/linux/rhel/docker-ce.repo
sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker agentplane

# PostgreSQL 16
sudo dnf install -y postgresql16-server postgresql16
sudo /usr/pgsql-16/bin/postgresql-16-setup initdb
sudo systemctl enable --now postgresql-16
sudo -u postgres createuser agentplane_app -P     # 记录密码 → /srv/agentplane/secrets/
sudo -u postgres createdb agentplane -O agentplane_app

# Redis 7
sudo dnf install -y redis && sudo systemctl enable --now redis
# /etc/redis/redis.conf:bind 127.0.0.1;appendonly yes(锁/队列状态崩溃可恢复)

# Caddy(自动 TLS;无公网域名则用内网 IP + tls internal)
sudo dnf install -y 'dnf-command(copr)' && sudo dnf copr enable -y @caddy/caddy && sudo dnf install -y caddy
sudo systemctl enable --now caddy
```

## 3. 目录布局与权限

```bash
sudo mkdir -p /srv/agentplane/{projects,workspaces,uploads,logs,artifacts,secrets/git,portal,api,worker,infra}
sudo chown -R agentplane:agentplane /srv/agentplane
sudo chmod 700 /srv/agentplane/secrets /srv/agentplane/uploads
sudo chmod 750 /srv/agentplane/workspaces      # agentplane-agent 经组进入,仅自身 run 目录可写(worker 创建时 chown)
# SELinux(enforcing 时):
sudo semanage fcontext -a -t var_t "/srv/agentplane(/.*)?" && sudo restorecon -Rv /srv/agentplane
```

## 4. Agent CLI

```bash
sudo -u agentplane-agent bash -c 'npm config set prefix ~/.npm-global'
# 按各 CLI 官方文档安装 Codex CLI 与 Claude Code 到 agentplane-agent 用户
# 验证(这是 Phase 0 Spike A 的入口):
sudo -u agentplane-agent claude --version
sudo -u agentplane-agent codex --version
# 模型 API key 写入 /home/agentplane-agent/.config/...(0600),不进任何 repo
```

## 5. Caddy 反代(SSE 关键配置)

```caddyfile
dev.example.com {
    handle /api/* {
        reverse_proxy 127.0.0.1:4000 {
            flush_interval -1        # SSE 必须:禁用缓冲
            transport http { read_timeout 0 }
        }
    }
    handle { reverse_proxy 127.0.0.1:3000 }
}
```

防火墙:`sudo firewall-cmd --permanent --add-service=https --add-service=http && sudo firewall-cmd --reload`(内网部署可仅放行 Tailscale 网段)。

## 6. systemd 单元(模板,infra/systemd/)

```ini
# /etc/systemd/system/agentplane-worker.service
[Unit]
Description=AgentPlane Worker
After=network.target redis.service postgresql-16.service
[Service]
User=agentplane
WorkingDirectory=/srv/agentplane/worker
EnvironmentFile=/srv/agentplane/secrets/worker.env
ExecStart=/usr/bin/node dist/main.js
Restart=always
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=/srv/agentplane
[Install]
WantedBy=multi-user.target
```

api/portal 同构(端口 4000/3000)。`sudo systemctl daemon-reload && sudo systemctl enable --now agentplane-{api,worker,portal}`。

## 7. 项目接入(每个被开发项目)

```bash
sudo -u agentplane ssh-keygen -t ed25519 -f /srv/agentplane/secrets/git/{slug}.key -N ''
# 公钥加到 GitHub 仓库 Deploy Key(勾选 write);然后:
sudo -u agentplane GIT_SSH_COMMAND="ssh -i /srv/agentplane/secrets/git/{slug}.key" \
  git clone --mirror git@github.com:org/repo.git /srv/agentplane/projects/{slug}.git
# Portal 中创建 project 记录,配置 test/build/deploy 命令模板与 compose.preview.yml
```

## 8. 备份与巡检

```bash
# cron(agentplane 用户):
0 2 * * *  pg_dump agentplane | gzip > /backup/agentplane-$(date +\%F).sql.gz
0 3 * * *  rsync -a /srv/agentplane/uploads/ /backup/uploads/
30 6 * * * /srv/agentplane/infra/scripts/gc.sh        # workspace/artifact 清理(见 05 §5)
```

巡检清单(每周):`df -h`(<85%)、`systemctl status agentplane-*`、PG/Redis 日志、fail2ban 状态、deploy key 年龄。

## 9. 验收

- [ ] https 入口可达,/healthz 200
- [ ] 三个 systemd 服务 active,reboot 后自启
- [ ] `sudo -u agentplane-agent claude --version` / `codex --version` 正常
- [ ] worktree 演练通过(Spike B)
- [ ] 备份 cron 产出文件
