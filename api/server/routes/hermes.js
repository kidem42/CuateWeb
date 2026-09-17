const { createHermesRouter, hermesRequestContext } = require('@librechat/api');
const { requireJwtAuth, configMiddleware } = require('~/server/middleware');
const express = require('express');
const multer = require('multer');

const router = express.Router();
router.use(requireJwtAuth, configMiddleware);
router.use(
  createHermesRouter({
    fetch: globalThis.fetch,
    multer,
    environment: process.env,
    context: hermesRequestContext,
  }),
);
module.exports = router;
