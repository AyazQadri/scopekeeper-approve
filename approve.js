/*
 * ScopeKeeper browser approval page. All data is rendered with textContent only.
 * Talks to Firestore's REST API directly (no SDK, no server); see approve-core.js.
 */
(function () {
  'use strict';

  var core = window.SKApprovalCore;
  var STORAGE_KEY = 'sk-approval-id';
  var api = core.firestoreBase(window.location.hostname);

  // The request ID is the link secret. It arrives in the fragment (never sent to servers);
  // strip it from the address bar and history, but keep it for a refresh of this tab.
  var requestId = core.readRequestId(window.location.hash);
  if (requestId) {
    try { window.sessionStorage.setItem(STORAGE_KEY, requestId); } catch (e) { /* storage unavailable */ }
  } else {
    try { requestId = core.readRequestId(window.sessionStorage.getItem(STORAGE_KEY) || ''); } catch (e) { requestId = null; }
  }
  if (window.location.hash) {
    window.history.replaceState(null, '', window.location.pathname);
  }

  var $ = function (id) { return document.getElementById(id); };

  var pendingDecision = null;
  var submitting = false;

  var DECISION_LABELS = {
    approved: 'Approved',
    rejected: 'Rejected',
    revision_requested: 'Revisions requested'
  };

  function el(tag, opts, children) {
    var node = document.createElement(tag);
    if (opts && opts.className) { node.className = opts.className; }
    if (opts && opts.text != null) { node.textContent = String(opts.text); }
    (children || []).forEach(function (c) { if (c) { node.appendChild(c); } });
    return node;
  }

  function show(state) {
    ['state-loading', 'state-message', 'state-review'].forEach(function (id) {
      $(id).hidden = id !== state;
    });
  }

  function setStatus(text, kind) {
    var s = $('status');
    s.textContent = text || '';
    s.className = 'status' + (kind ? ' ' + kind : '');
  }

  function showMessage(title, body, canRetry) {
    $('message-title').textContent = title;
    $('message-body').textContent = body;
    $('retry').hidden = !canRetry;
    show('state-message');
  }

  function formatMoney(minor, currency) {
    var value = (Number(minor) || 0) / 100;
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD' }).format(value);
    } catch (e) {
      return value.toFixed(2) + ' ' + (currency || '');
    }
  }

  function formatDate(iso) {
    if (!iso) { return 'Not set'; }
    var d = new Date(iso.length === 10 ? iso + 'T00:00:00Z' : iso);
    if (isNaN(d.getTime())) { return String(iso); }
    var opts = iso.length === 10
      ? { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }
      : { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
    return d.toLocaleString(undefined, opts);
  }

  function listSection(title, items) {
    if (!items || !items.length) { return null; }
    return el('div', null, [
      el('h3', { text: title }),
      el('ul', null, items.map(function (t) { return el('li', { text: t }); }))
    ]);
  }

  function textSection(title, text) {
    if (!text) { return null; }
    return el('div', null, [el('h3', { text: title }), el('p', { className: 'pre', text: text })]);
  }

  function metaRow(dl, label, value) {
    dl.appendChild(el('dt', { text: label }));
    dl.appendChild(el('dd', { text: value }));
  }

  function renderScope(snapshot) {
    var c = snapshot.scope.content || {};
    var milestones = (c.milestones || []).map(function (m) {
      return m.title + (m.dueDate ? ' — ' + formatDate(m.dueDate) : '');
    });
    return el('div', { className: 'card' }, [
      el('h2', { text: 'Scope of work' }),
      listSection('Objectives', c.objectives),
      listSection('Deliverables', c.deliverables),
      listSection('Included', c.included),
      listSection('Not included', c.excluded),
      listSection('Milestones', milestones),
      c.revisionLimit != null ? textSection('Revisions included', String(c.revisionLimit)) : null,
      listSection('Acceptance criteria', c.acceptanceCriteria),
      textSection('Payment terms', c.paymentTerms),
      textSection('Notes', c.notes)
    ]);
  }

  function renderChangeRequest(snapshot) {
    var cr = snapshot.changeRequest;
    var impact = Number(cr.deadlineImpactDays) || 0;
    var impactText = impact === 0 ? 'No change to the deadline'
      : (impact > 0 ? '+' : '') + impact + ' day' + (Math.abs(impact) === 1 ? '' : 's');
    var costCard = el('div', { className: 'card highlight' }, [
      el('h2', { text: 'Price and deadline impact' }),
      el('p', { className: 'amount', text: (cr.additionalCostMinor > 0 ? '+' : '') + formatMoney(cr.additionalCostMinor, cr.currency) }),
      el('p', { className: 'muted', text: 'Additional cost' })
    ]);
    var dl = el('dl', { className: 'meta' });
    metaRow(dl, 'Deadline impact', impactText);
    if (cr.newDueDate) { metaRow(dl, 'New due date', formatDate(cr.newDueDate)); }
    metaRow(dl, 'Current due date', formatDate(snapshot.project.dueDate));
    costCard.appendChild(dl);

    return el('div', null, [
      costCard,
      el('div', { className: 'card' }, [
        el('h2', { text: 'Requested change' }),
        textSection('Description', cr.description),
        textSection('Reason', cr.reason),
        listSection('Changes', cr.requestedChanges),
        cr.basedOnScopeVersionNumber ? textSection('Based on', 'Scope version ' + cr.basedOnScopeVersionNumber) : null
      ])
    ]);
  }

  function renderDecided(decision, status) {
    var summary = $('decided-summary');
    summary.textContent = '';
    var badge = el('span', { className: 'badge ' + status, text: DECISION_LABELS[status] || status });
    summary.appendChild(badge);
    if (decision) {
      summary.appendChild(document.createTextNode(
        ' by ' + decision.signerName + (decision.decidedAt ? ' on ' + formatDate(decision.decidedAt) : '')
      ));
    }
    var comment = $('decided-comment');
    comment.textContent = decision && decision.comment ? decision.comment : '';
    comment.hidden = !(decision && decision.comment);
    $('decided').hidden = false;
    $('decision-form').hidden = true;
  }

  function render(data) {

    var s = data.snapshot || {};
    var project = s.project || {};
    var isScope = data.targetType === 'scope' && s.scope;

    $('review-eyebrow').textContent = (s.businessName || 'Your service provider') + ' asks for your review';
    $('review-title').textContent = isScope
      ? project.title + ' — Scope v' + s.scope.versionNumber
      : project.title + ' — ' + ((s.changeRequest && s.changeRequest.title) || 'Change request');

    var meta = $('review-meta');
    meta.textContent = '';
    metaRow(meta, 'Prepared for', data.clientName || project.clientName || '');
    metaRow(meta, 'From', s.businessName || '');
    metaRow(meta, 'Project budget', formatMoney(project.budgetMinor, project.currency));
    metaRow(meta, 'Due date', formatDate(project.dueDate));
    if (data.status === 'pending') { metaRow(meta, 'Link expires', formatDate(data.expiresAt)); }

    var body = $('review-body');
    body.textContent = '';
    if (isScope) { body.appendChild(renderScope(s)); }
    else if (s.changeRequest) { body.appendChild(renderChangeRequest(s)); }

    $('legal-notice').textContent =
      'Your decision, typed name and the time it was received are recorded by ScopeKeeper and shared with ' +
      (s.businessName || 'the sender') +
      '. This record is not a legally binding electronic signature unless you and the sender have agreed otherwise.';

    if (data.status === 'pending') {
      $('decided').hidden = true;
      $('decision-form').hidden = false;
      if (!$('signer-name').value && data.clientName) { $('signer-name').value = data.clientName; }
    } else {
      renderDecided(data.decision, data.status);
    }
    show('state-review');
  }

  function showClosed(status) {
    if (status === 'revoked') {
      showMessage('Request withdrawn', 'The sender withdrew this request. They may send you an updated one.', false);
    } else {
      showMessage('This link has expired', 'Ask the sender to send you a new approval link.', false);
    }
  }

  function fetchRequest() {
    return fetch(api + '/approvalRequests/' + encodeURIComponent(requestId), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer'
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (body) {
        return { status: res.status, body: body };
      });
    });
  }

  function load() {
    setStatus('');
    if (!requestId) {
      showMessage('Incomplete link', 'This approval link is missing information. Open the complete link from your message.', false);
      return;
    }
    show('state-loading');
    fetchRequest().then(function (res) {
      if (res.status === 200 && res.body) {
        var view = core.toView(res.body);
        if (view.status === 'revoked' || view.status === 'expired') { showClosed(view.status); }
        else { render(view); }
      } else if (res.status === 404 || res.status === 403) {
        showMessage('This link is not valid', 'Check that you opened the complete link you were sent, or ask the sender for a new one.', false);
      } else {
        showMessage('Something went wrong', 'We could not load this request. Check your connection and try again.', true);
      }
    }).catch(function () {
      showMessage('Connection problem', 'We could not reach ScopeKeeper. Check your connection and try again.', true);
    });
  }

  function setButtonsDisabled(disabled) {
    var buttons = document.querySelectorAll('#decision-form button');
    for (var i = 0; i < buttons.length; i++) { buttons[i].disabled = disabled; }
    $('signer-name').disabled = disabled;
    $('comment').disabled = disabled;
  }

  function validate(decision) {
    var result = core.validateDecision(decision, $('signer-name').value, $('comment').value);
    return result.error ? { error: result.error, focus: result.field || 'signer-name' } : result;
  }

  function askConfirm(decision) {
    var result = validate(decision);
    var err = $('form-error');
    if (result.error) {
      err.textContent = result.error;
      $(result.focus).focus();
      return;
    }
    err.textContent = '';
    pendingDecision = decision;
    var verb = decision === 'approved' ? 'approve' : decision === 'rejected' ? 'reject' : 'request revisions to';
    $('confirm-text').textContent = 'Are you sure you want to ' + verb + ' this as ' + result.signerName + '? This cannot be undone.';
    $('decision-buttons').hidden = true;
    $('confirm').hidden = false;
    $('confirm-yes').focus();
  }

  function cancelConfirm() {
    pendingDecision = null;
    $('confirm').hidden = true;
    $('decision-buttons').hidden = false;
  }

  function submit() {
    if (submitting || !pendingDecision) { return; }
    var result = validate(pendingDecision);
    if (result.error) { cancelConfirm(); $('form-error').textContent = result.error; return; }
    submitting = true;
    setButtonsDisabled(true);
    $('confirm-yes').textContent = 'Submitting…';
    setStatus('');

    fetch(api + ':commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      body: JSON.stringify(core.buildDecisionCommit(requestId, result))
    }).then(function (res) {
      if (res.ok) {
        // Show the decision only after Firestore accepted it, as stored (with its server time)
        return fetchRequest().then(function (after) {
          if (after.status === 200 && after.body) { render(core.toView(after.body)); }
          setStatus('Thank you — your decision was recorded. ' + 'The sender will see it in ScopeKeeper.', 'success');
        });
      }
      if (res.status === 403 || res.status === 404 || res.status === 400) {
        // Rules refused: already decided, withdrawn or expired meanwhile. Show the current state.
        setStatus('Your decision could not be recorded because this request is no longer open.', 'error');
        load();
        return null;
      }
      $('form-error').textContent = 'Your decision was not recorded. Please try again.';
      return null;
    }).catch(function () {
      $('form-error').textContent = 'We could not reach ScopeKeeper, so your decision was not recorded. Check your connection and try again.';
    }).then(function () {
      submitting = false;
      setButtonsDisabled(false);
      $('confirm-yes').textContent = 'Confirm';
      cancelConfirm();
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    var buttons = document.querySelectorAll('[data-decision]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener('click', function (e) { askConfirm(e.currentTarget.getAttribute('data-decision')); });
    }
    $('confirm-yes').addEventListener('click', submit);
    $('confirm-no').addEventListener('click', cancelConfirm);
    $('retry').addEventListener('click', load);
    $('decision-form').addEventListener('submit', function (e) { e.preventDefault(); });
    $('comment').addEventListener('input', function () { $('form-error').textContent = ''; });
    load();
  });
})();
