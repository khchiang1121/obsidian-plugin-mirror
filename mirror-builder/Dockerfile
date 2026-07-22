FROM nginx:alpine

RUN apk update && \
    apk add --no-cache --upgrade openssl libssl3 libcrypto3

COPY dist/ /usr/share/nginx/html/
