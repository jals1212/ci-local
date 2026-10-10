# shellcheck shell=bash
# The fixture project of ci-local's own tests.
# shellcheck disable=SC2034
CI_PROJECT=fixture-ci
# shellcheck disable=SC2034
CI_JOBS=(quality tests)

ci_env tests NODE_ENV=test DB_HOST=db

ci_not_mirrored "Start the database" "start_database: on the private network, no published port"

start_database() {
  docker run --detach --name fixture-ci-db --network "$CI_NETWORK" --network-alias db \
    --label "$CI_LABEL" postgres:17 >/dev/null
}

ci_plan() {
  ci_step host "Build the runner image" ci_build_runner
  ci_step host "Start the Linux runner" ci_start_runner
  ci_step box "npm ci" 'npm ci'
  ci_step box "Audit" --job quality --tag audit --pass NPM_TOKEN 'npm audit signatures'
  ci_step box "npm run lint" --job quality --timeout 600 'npm run lint'
  ci_step host "Start the database" --job tests start_database postgres:17 "pg_isready -U postgres"
  ci_step box "Create the database" --job tests 'docker exec fixture-ci-db createdb -U postgres app'
  ci_step box "npm test" --job tests --env tests --set EXTRA=1 'npm test'
  ci_step box "npm run e2e" --job tests --deviates "leaves out the spec that needs the host network" \
    'npm run e2e -- --exclude host_network.spec.ts'
}
