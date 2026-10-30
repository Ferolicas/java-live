#!/usr/bin/env bash
# Provisión única del VPS para java-live (idempotente). Ejecutar como root desde la raíz del repo.
set -euo pipefail
BASE=/var/lib/java-live

export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l
dpkg -s openjdk-21-jdk-headless >/dev/null 2>&1 || apt-get install -y --no-install-recommends --no-upgrade openjdk-21-jdk-headless

id javalive >/dev/null 2>&1 || useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin javalive

mkdir -p "$BASE/jobs" /var/www/java-live/releases
# raíz mínima visible para el código ajeno: solo librerías/JDK y timeout (solo lectura), sin shell ni utilidades
rm -rf "$BASE/root/usr" "$BASE/root/bin" "$BASE/root/sbin"
mkdir -p "$BASE/root"/{usr/lib,usr/lib64,usr/bin,etc/java-21-openjdk,work,tmp,dev,proc,sys,run}
touch "$BASE/root/etc/ld.so.cache" "$BASE/root/usr/bin/timeout"
for l in lib lib64; do ln -sfn "usr/$l" "$BASE/root/$l"; done
chmod 755 "$BASE" "$BASE/root"

# los trabajos viven en tmpfs con tope: un programa que llene disco solo llena esto
grep -q " $BASE/jobs " /etc/fstab || echo "tmpfs $BASE/jobs tmpfs size=200m,nr_inodes=20000,mode=0711,uid=javalive,gid=javalive,nosuid,nodev 0 0" >> /etc/fstab
mountpoint -q "$BASE/jobs" || mount "$BASE/jobs"

install -m 0755 -o root -g root deploy/java-live-run /usr/local/sbin/java-live-run
install -m 0755 -o root -g root deploy/java-live-deploy /usr/local/sbin/java-live-deploy
echo 'javalive ALL=(root) NOPASSWD: /usr/local/sbin/java-live-run' > /etc/sudoers.d/java-live
chmod 440 /etc/sudoers.d/java-live
visudo -cf /etc/sudoers.d/java-live >/dev/null
install -m 0644 -o root -g root deploy/ecosystem.config.cjs /var/www/java-live/ecosystem.config.cjs
echo "setup OK"
