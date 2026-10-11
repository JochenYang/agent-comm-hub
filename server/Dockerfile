# agent-comm-hub — 一体化容器（hub + SQLite 状态卷）。
# 镜像只封装 hub 本身；对外 TLS 仍建议由 Caddy/nginx 终结（见同目录示例）。
FROM node:22-alpine

# Pinned, not `latest`: a container that silently changes version on rebuild is not
# reproducible. The release SOP updates this alongside the other version strings;
# --build-arg HUB_VERSION=x.y.z builds a specific release.
ARG HUB_VERSION=0.9.1

RUN npm install -g agent-comm-hub@${HUB_VERSION}

# 状态（history / 信箱 / 花名册 / 群组）落在 /data 卷；令牌表也建议放这里（chmod 600）。
VOLUME /data

# Run as a non-root user. The hub only needs to read its config and write /data,
# and this is the process most likely to face the public internet.
RUN addgroup -S hub && adduser -S -G hub hub && chown -R hub:hub /data
USER hub

EXPOSE 18764

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
    CMD wget -qO- http://127.0.0.1:18764/healthz || exit 1

# 容器内必须监听 0.0.0.0 才能被端口映射到宿主；令牌鉴权因此是硬要求
# （AUTH_TOKENS 指向挂载进来的令牌表）。
ENTRYPOINT ["agent-comm-hub"]
CMD ["--host", "0.0.0.0", "--port", "18764", \
     "--auth-tokens", "/data/tokens.json", \
     "--db", "/data/state.db"]
