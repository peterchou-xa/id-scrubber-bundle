server {
    server_name identityscrubber.com www.identityscrubber.com;

    root /var/www/identityscrubber.com;
    index index.html;

    location /.well-known/acme-challenge/ {
        root /var/www/identityscrubber.com;
    }

    location / {
        try_files $uri /index.html;
    }

    # Reverse proxy for NestJS API
    location /api/ {
        # proxy_pass has no trailing slash, so nginx forwards the full URI
        # unchanged (path prefix preserved). NestJS expects the /api prefix.
        #   client: /api/metrics/scrub-events  ->  backend: /api/metrics/scrub-events
        # Adding a trailing slash here would strip /api/ from the forwarded path.
        proxy_pass http://127.0.0.1:3030;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    listen [::]:443 ssl; # managed by Certbot
    listen 443 ssl; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/identityscrubber.com/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/identityscrubber.com/privkey.pem; # managed by Certbot
    include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; # managed by Certbot


}
server {
    if ($host = www.identityscrubber.com) {
        return 301 https://$host$request_uri;
    } # managed by Certbot


    if ($host = identityscrubber.com) {
        return 301 https://$host$request_uri;
    } # managed by Certbot


    listen 80;
    listen [::]:80;
    server_name identityscrubber.com www.identityscrubber.com;
    return 404; # managed by Certbot
}