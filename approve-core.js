/*
 * ScopeKeeper approval page core: Firestore REST encoding/decoding and request building.
 * No Firebase SDK and no server: the page talks to Firestore directly, and
 * firebase/firestore.rules decide what a link holder may read and write.
 * Shared by approve.js (browser) and tests (Node) — keep it dependency-free.
 */
/* global self */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SKApprovalCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PROJECT_ID = 'scopekeeper-app';
  var ID_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
  var DECISIONS = ['approved', 'rejected', 'revision_requested'];
  var SIGNER_MAX = 120;
  var COMMENT_MAX = 2000;

  /** Request ID from the link fragment: https://…/approve#<id>. Never sent to any server. */
  function readRequestId(hash) {
    var id = (hash || '').replace(/^#/, '').trim();
    return ID_PATTERN.test(id) ? id : null;
  }

  /** Local Hosting emulator talks to the local Firestore emulator; production to Google. */
  // projectId is only overridden by tests (emulator demo project)
  function firestoreBase(hostname, projectId) {
    var local = hostname === 'localhost' || hostname === '127.0.0.1';
    var origin = local ? 'http://127.0.0.1:8080' : 'https://firestore.googleapis.com';
    return origin + '/v1/projects/' + (projectId || PROJECT_ID) + '/databases/(default)/documents';
  }

  function documentName(requestId, projectId) {
    return 'projects/' + (projectId || PROJECT_ID) + '/databases/(default)/documents/approvalRequests/' + requestId;
  }

  /** Firestore REST typed value → plain JS value */
  function decodeValue(v) {
    if (!v || typeof v !== 'object') { return null; }
    if ('stringValue' in v) { return v.stringValue; }
    if ('integerValue' in v) { return Number(v.integerValue); }
    if ('doubleValue' in v) { return Number(v.doubleValue); }
    if ('booleanValue' in v) { return !!v.booleanValue; }
    if ('nullValue' in v) { return null; }
    if ('timestampValue' in v) { return v.timestampValue; }
    if ('arrayValue' in v) { return (v.arrayValue.values || []).map(decodeValue); }
    if ('mapValue' in v) { return decodeFields(v.mapValue.fields || {}); }
    return null;
  }

  function decodeFields(fields) {
    var out = {};
    Object.keys(fields || {}).forEach(function (k) { out[k] = decodeValue(fields[k]); });
    return out;
  }

  /** The client only ever sees what it needs; ownerId etc. stay out of the view model. */
  function toView(doc) {
    var d = decodeFields((doc && doc.fields) || {});
    var expired = d.status === 'pending' && !!d.expiresAt && Date.parse(d.expiresAt) <= Date.now();
    return {
      status: expired ? 'expired' : d.status,
      targetType: d.targetType,
      snapshot: d.snapshot || {},
      clientName: d.clientName || '',
      expiresAt: d.expiresAt || null,
      decision: d.decision || null
    };
  }

  /** Mirrors the rules: name 2–120 chars, comment ≤ 2000 and required unless approving. */
  function validateDecision(decision, signerName, comment) {
    var name = (signerName || '').trim();
    var note = (comment || '').trim();
    if (DECISIONS.indexOf(decision) === -1) {
      return { error: 'Choose approve, reject or request revisions.', field: null };
    }
    if (name.length < 2 || name.length > SIGNER_MAX) {
      return { error: 'Enter your full name (2–120 characters).', field: 'signer-name' };
    }
    if (decision !== 'approved' && !note) {
      return { error: 'Please explain what should change.', field: 'comment' };
    }
    if (note.length > COMMENT_MAX) {
      return { error: 'Comment is too long (max 2000 characters).', field: 'comment' };
    }
    return { decision: decision, signerName: name, comment: note };
  }

  /**
   * One commit: set status + decision, and let Firestore stamp decidedAt (top level and inside
   * the decision) with the request time. The rules require exactly this shape.
   */
  function buildDecisionCommit(requestId, value, projectId) {
    return {
      writes: [
        {
          update: {
            name: documentName(requestId, projectId),
            fields: {
              status: { stringValue: value.decision },
              decision: {
                mapValue: {
                  fields: {
                    decision: { stringValue: value.decision },
                    signerName: { stringValue: value.signerName },
                    comment: { stringValue: value.comment }
                  }
                }
              }
            }
          },
          updateMask: { fieldPaths: ['status', 'decision'] },
          updateTransforms: [
            { fieldPath: 'decidedAt', setToServerValue: 'REQUEST_TIME' },
            { fieldPath: 'decision.decidedAt', setToServerValue: 'REQUEST_TIME' }
          ],
          currentDocument: { exists: true }
        }
      ]
    };
  }

  return {
    PROJECT_ID: PROJECT_ID,
    readRequestId: readRequestId,
    firestoreBase: firestoreBase,
    decodeValue: decodeValue,
    decodeFields: decodeFields,
    toView: toView,
    validateDecision: validateDecision,
    buildDecisionCommit: buildDecisionCommit
  };
});
