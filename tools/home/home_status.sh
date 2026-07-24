#!/bin/bash

echo "=============================="
echo "DOCKER CONTAINERS"
echo "=============================="
docker ps

echo ""
echo "=============================="
echo "HOME ASSISTANT LOGS"
echo "=============================="
docker logs --tail=20 homeassistant

echo ""
echo "=============================="
echo "SCRYPTED LOGS"
echo "=============================="
docker logs --tail=20 scrypted

echo ""
echo "=============================="
echo "SYSTEM STATUS"
echo "=============================="
uptime
free -h
df -h /
