#!/bin/sh
# Runs once, on first boot of an empty data volume.
# Creates the restricted application role and the test database.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE secure_doc_app LOGIN PASSWORD '${APP_DB_PASSWORD}';
CREATE DATABASE secure_doc_test OWNER secure_doc_owner;
SQL
