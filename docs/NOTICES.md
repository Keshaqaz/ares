# Notices of included dependencies

This project declares one runtime dependency, resolved through
`package-lock.json`. In the source tree it is installed from the npm registry
by `npm ci` and is not vendored; the Homebrew release archive bundles it
(`bundleDependencies`).

## libsodium-wrappers 0.7.15 — ISC License

    Copyright (c) 2015-2023
    Ahmad Ben Mrad <batikhsouri at gmail dot org>
    Frank Denis <j at pureftpd dot org>
    Ryan Lester <ryan at cyph dot com>

    Permission to use, copy, modify, and/or distribute this software for any
    purpose with or without fee is hereby granted, provided that the above
    copyright notice and this permission notice appear in all copies.

    THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
    WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
    MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
    ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
    WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
    ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
    OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.


## libsodium 0.7.16 — ISC License (transitive dependency)

    Copyright (c) 2015-2026
    Ahmad Ben Mrad <batikhsouri at gmail dot org>
    Frank Denis <j at pureftpd dot org>
    Ryan Lester <ryan at cyph dot com>
    
    Permission to use, copy, modify, and/or distribute this software for any
    purpose with or without fee is hereby granted, provided that the above
    copyright notice and this permission notice appear in all copies.
    
    THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
    WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
    MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
    ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
    WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
    ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
    OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

Runtime (not distributed with this project): Node.js 26 or newer, taken from
Homebrew's `node` formula when installed with Homebrew (the Node.js license
applies to the runtime, not to this code).
