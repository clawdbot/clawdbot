# Bundled plugin icon sources

The package-local icon cutover includes the two bundled plugins that otherwise have no Control UI artwork fallback. This keeps the base contract independently merge-safe before the complete bundled-plugin icon catalog lands in the stacked follow-up.

Third-party names and marks remain the property of their respective owners and are used to identify the integration. The runtime never fetches these source URLs.

| Plugin         | Source class             | Artwork source                                                                                                        |
| -------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| teams-meetings | first-party brand asset  | [source](https://res.cdn.office.net/files/fabric-cdn-prod_20230815.001/assets/brand-icons/product/svg/teams_48x1.svg) |
| zoom-meetings  | Simple Icons brand asset | [source](https://cdn.simpleicons.org/zoom)                                                                            |
