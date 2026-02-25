FROM docker.io/cloudflare/sandbox:0.7.0

# --- Repo-specific setup ---

# Install Node 22 (Astro requires >=22.12.0, sandbox base image has Node 20).
# NodeSource installs to /usr/bin/node but the base image's Node 20 lives at
# /usr/local/bin/node which takes precedence on PATH. Replace it with a symlink.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/node /usr/local/bin/node

# Install pnpm
RUN npm install -g pnpm

# Pre-bake Astro repo with deps (node_modules).
# At runtime, the workflow will `git fetch + reset --hard` to update to latest,
# then `pnpm install` (cached) + `pnpm run build`.
ENV NODE_OPTIONS=--max-old-space-size=4096
RUN git clone --branch main --depth 1 \
    https://github.com/withastro/astro.git /home/user/astro
WORKDIR /home/user/astro
RUN pnpm install --frozen-lockfile && pnpm store prune

# --- Flue tooling ---

# Add opencode install location to PATH before installation
ENV PATH="/root/.opencode/bin:${PATH}"

# Install OpenCode CLI
RUN curl -fsSL https://opencode.ai/install -o /tmp/install-opencode.sh \
    && bash /tmp/install-opencode.sh \
    && rm /tmp/install-opencode.sh \
    && opencode --version

# Install agent-browser CLI + Chromium for headless browser testing.
# 1. Install system deps required by Chromium (no sudo in container, we're root)
# 2. Install agent-browser + playwright (for the `playwright install` CLI)
# 3. Download Chromium via playwright, then remove the playwright package (only needed for download)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       libxcb-shm0 libx11-xcb1 libx11-6 libxcb1 libxext6 libxrandr2 \
       libxcomposite1 libxcursor1 libxdamage1 libxfixes3 libxi6 libgtk-3-0 \
       libpangocairo-1.0-0 libpango-1.0-0 libatk1.0-0 libcairo-gobject2 \
       libcairo2 libgdk-pixbuf-2.0-0 libxrender1 libasound2 libfreetype6 \
       libfontconfig1 libdbus-1-3 libnss3 libnspr4 libatk-bridge2.0-0 \
       libdrm2 libxkbcommon0 libatspi2.0-0 libcups2 libxshmfence1 libgbm1 \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g agent-browser playwright \
    && playwright install chromium \
    && npm uninstall -g playwright

# Install GitHub CLI (for public repo access without auth)
RUN (type -p wget >/dev/null || (apt-get update && apt-get install wget -y)) \
    && mkdir -p -m 755 /etc/apt/keyrings \
    && out=$(mktemp) && wget -nv -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    && cat $out | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install gh -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /home/user

# Expose OpenCode server port
EXPOSE 48765
