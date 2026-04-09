'use strict';
// Force IPv4 DNS resolution.
// Fixes Codespace / Docker / corporate-network IPv6 routing issues where
// AAAA records resolve but the IPv6 path is unreachable.
// Safe to require multiple times — setDefaultResultOrder is idempotent.
require('dns').setDefaultResultOrder('ipv4first');
