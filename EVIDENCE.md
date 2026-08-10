# Pull Request Evidence

## What Problem To Solve?
The deployment on Railway fails due to an invalid cache mount ID configuration in the Dockerfile. Platform builders restrict custom cache keys like `openclaw-pnpm-store` and enforce the `id=s/<service-id>-<target-path>` prefix format. A runtime `EACCES` permission denied error also occurs on application startup.

## Proposed Solution
Update the Dockerfile to use the mandated Railway cache key format and ensure proper folder ownership and permissions are allocated during the final build stages.
