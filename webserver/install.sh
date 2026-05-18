#!/bin/bash

# sudo bash webserver/install.sh          # copies web content
# sudo bash webserver/install.sh --nginx  # copies nginx configs and reloads
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [[ "$1" == "--nginx" ]]; then
  echo "Copying nginx configs to /etc/nginx/sites-enabled/..."
  cp "$SCRIPT_DIR/sites-enabled/default" /etc/nginx/sites-enabled/default
  cp "$SCRIPT_DIR/sites-enabled/identityscrubber.com" /etc/nginx/sites-enabled/identityscrubber.com

  echo "Reloading nginx..."
  nginx -t && systemctl reload nginx
else
  # Copy identityscrubber.com content
  TARGET="/var/www/identityscrubber.com"
  echo "Copying website content to $TARGET..."
  mkdir -p "$TARGET"
  cp -r "$SCRIPT_DIR/content"/* "$TARGET"/
fi

echo "Done."
