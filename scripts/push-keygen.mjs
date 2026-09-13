#!/usr/bin/env node
// Prints a fresh VAPID key pair for push notifications, in both config.yml
// and .env form. Run once per deployment and keep the private key private.
import webPush from "web-push";

const { publicKey, privateKey } = webPush.generateVAPIDKeys();

console.log(`# config/config.yml
powerflow:
  notify:
    vapid_public_key: "${publicKey}"
    vapid_private_key: "${privateKey}"

# ...or .env
POWERFLOW_VAPID_PUBLIC_KEY=${publicKey}
POWERFLOW_VAPID_PRIVATE_KEY=${privateKey}`);
