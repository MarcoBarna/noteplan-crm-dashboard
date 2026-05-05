
// CONSTANTS & SETTINGS

const SETTINGS = {
  relationshipTag: "contact",
  dataFolder: "@CRM",
}

const PLUGIN_ID = "np.jokky102.crm"

// Reads a setting from DataStore.settings, falling back to defaultValue
function getSetting(key, defaultValue) {
  const value = DataStore.settings[key]
  if (value !== undefined && value !== null && String(value) !== "") return value
  return defaultValue
}

const INTERACTION_TYPES_DEFAULT = [
  "☎️ Call",
  "📧 Email",
  "🤝 Meeting",
  "💬 Text",
  "📱 Social",
  "📝 Other",
]

// Returns the active interaction types from settings, falling back to defaults
function getInteractionTypes() {
  const raw = getSetting("crm-interaction-types", "")
  if (typeof raw === "string" && raw.trim()) {
    return raw.split(",").map(s => s.trim()).filter(s => s.length > 0)
  }
  return INTERACTION_TYPES_DEFAULT
}

const REMINDER_FREQUENCIES = {
  day: "Every day",
  week: "Every week",
  twoWeeks: "Every 2 weeks",
  threeWeeks: "Every 3 weeks",
  month: "Every month",
  twoMonths: "Every 2 months",
  quarter: "Every 3 months",
  sixMonths: "Every 6 months",
  year: "Every year",
  never: "Never",
}

const WINDOW_ID = "np.jokky102.crm.main"

// MAIN COMMANDS

async function addRelationship() {
  try {
    // invokePluginCommandByName expects a return value; return {} to suppress log errors
    const defaultCategories = ["Client", "Colleague", "Friend", "Family"]
    const customCatsRaw = getSetting("crm-custom-categories", "")
    const customCats = typeof customCatsRaw === "string" && customCatsRaw.trim()
      ? customCatsRaw.split(",").map(s => s.trim()).filter(s => s.length > 0)
      : []
    const allCategories = [...defaultCategories, ...customCats]

    const formResult = await CommandBar.showForm({
      title: "Add Contact",
      submitText: "Create",
      fields: [
        {
          type: "string",
          key: "name",
          title: "Name",
          placeholder: "Contact name",
          required: true,
        },
        {
          type: "string",
          key: "category",
          title: "Category",
          choices: allCategories,
          required: true,
        },
        {
          type: "string",
          key: "frequency",
          title: "Connect frequency",
          choices: Object.values(REMINDER_FREQUENCIES),
          required: true,
        },
      ],
    })

    if (!formResult.submitted) return {}

    const name = formResult.values.name
    const frequencyText = formResult.values.frequency
    const reminderFreqKey = Object.keys(REMINDER_FREQUENCIES)[
      Object.values(REMINDER_FREQUENCIES).indexOf(frequencyText)
    ]

    const tagPrefix = getSetting("crm-relationship-tag", SETTINGS.relationshipTag)
    const noteContent = createContactNote(
      name,
      formResult.values.category,
      frequencyText,
      reminderFreqKey,
      tagPrefix
    )

    const filename = DataStore.newNoteWithContent(
      noteContent,
      getDataFolder(),
      `${name.replace(/[\/\\:*?"<>|]/g, "")}.md`
    )

    if (reminderFreqKey !== "never") {
      scheduleNextReminder(name, reminderFreqKey, filename)
    }

    await CommandBar.prompt(
      "Contact created!",
      `${name} has been added to your CRM`,
      ["OK"]
    )
    
    // Refresh dashboard if open, otherwise do nothing
    await refreshDashboardIfOpen()
    return {}
  } catch (error) {
    console.log(`❌ Error creating contact: ${error.message}`)
    return {}
  }
}

async function showCRMDashboard() {
  try {
    const contacts = await getRelationships()
    const html = getCRMDashboardHTML(contacts)

    await HTMLView.showInMainWindow(html, "CRM Dashboard", {
      customId: WINDOW_ID,
      splitView: false,
      icon: "users",
      iconColor: "blue-500",
      autoTopPadding: true,
    })
  } catch (error) {
    console.log(`❌ Error showing dashboard: ${error.message}`)
  }
}

// Base function: log interaction without creating a reminder
async function logInteractionBase(contact) {
  try {
    const formResult = await CommandBar.showForm({
      title: "Log Interaction with " + contact.name,
      submitText: "Log",
      fields: [
        {
          type: "string",
          key: "type",
          title: "Interaction Type",
          choices: getInteractionTypes(),
          required: true,
        },
        {
          type: "string",
          key: "notes",
          title: "Notes",
          placeholder: "Interaction notes",
          boxHeight: 120,
        },
      ],
    })

    if (!formResult.submitted) return false

    const interactionType = formResult.values.type
    const notes = formResult.values.notes

    // Reads the note directly without opening it in the editor
    const note = DataStore.projectNoteByFilename(contact.filename)
    if (!note) {
      console.log(`❌ Could not open note: ${contact.filename}`)
      return false
    }

    const interaction = `${formatDateTime(new Date())} ${interactionType} - ${notes || "No notes"}`
    let interactionPosition = getSetting("crm-interaction-position", "append")
    if (typeof interactionPosition === "boolean") {
      interactionPosition = interactionPosition ? "prepend" : "append"
    }
    if (interactionPosition === "prepend") {
      // Insert after the "## Interactions" heading if it exists, otherwise at the top
      const interactionsHeading = note.paragraphs.find(
        p => p.type === "title" && p.content.trim() === "Interactions"
      )
      if (interactionsHeading) {
        note.insertParagraph(interaction, interactionsHeading.lineIndex + 1, "list")
      } else {
        note.prependParagraph(interaction, "list")
      }
    } else {
      note.appendParagraph(interaction, "list")
    }

    note.content = updateFrontmatterKey(note.content, "last_contact", formatDate(new Date()))

    return true
  } catch (error) {
    console.log(`❌ Error logging interaction: ${error.message}`)
    return false
  }
}

// Command 1: Log interaction only (no reminder)
async function addInteraction() {
  try {
    const contacts = await getRelationships()
    if (contacts.length === 0) {
      await CommandBar.prompt("No contacts", "Create a Contact first.", ["OK"])
      return
    }

    const contactChoice = await CommandBar.showOptions(
      contacts.map((c) => c.name),
      "Select contact"
    )
    const contact = contacts[contactChoice.index]

    const success = await logInteractionBase(contact)
    if (!success) return

    await CommandBar.prompt(
      "Interaction logged!",
      `Added interaction for ${contact.name}`,
      ["OK"]
    )

    // ✅ Navigate to the contact note only if the preference is enabled
    const navigateAfterInteraction = getSetting("crm-navigate-after-interaction", "true")
    if (navigateAfterInteraction !== "false") {
      await Editor.openNoteByFilename(contact.filename)
    }

    // ✅ If the dashboard is open, refresh it in the background without navigating to it
    await refreshDashboardIfOpen()
    return {}
  } catch (error) {
    console.log(`❌ Error adding interaction: ${error.message}`)
    return {}
  }
}

// Command 2: Log interaction AND schedule next reminder
async function logInteractionWithReminder() {
  try {
    const contacts = await getRelationships()
    if (contacts.length === 0) {
      await CommandBar.prompt("No contacts", "Create a Contact first.", ["OK"])
      return
    }

    const contactChoice = await CommandBar.showOptions(
      contacts.map((c) => c.name),
      "Select contact"
    )
    const contact = contacts[contactChoice.index]

    const success = await logInteractionBase(contact)
    if (!success) return

    // ✅ Complete the contact's reminder for today
    await completeContactReminder(contact.name)

    // ✅ Create the next reminder if configured
    const hasValidFreqKey = contact.frequencyKey && contact.frequencyKey.trim() !== "" && contact.frequencyKey !== "never"
    if (hasValidFreqKey) {
      try {
        const nextDate = getNextReminderDate(contact.frequencyKey)
        scheduleCalendarReminder(buildReminderTitle(contact.name), nextDate, contact.filename)
      } catch (reminderError) {
        console.log(`❌ Error creating reminder: ${reminderError.message}`)
      }
    }

    await CommandBar.prompt(
      "Interaction logged!",
      `Added interaction for ${contact.name} with reminder scheduled`,
      ["OK"]
    )

    // ✅ Navigate to the contact note only if the preference is enabled
    const navigateAfterInteraction = getSetting("crm-navigate-after-interaction", "true")
    if (navigateAfterInteraction !== "false") {
      await Editor.openNoteByFilename(contact.filename)
    }

    // ✅ If the dashboard is open, refresh it in the background without navigating to it
    await refreshDashboardIfOpen()
    return {}
  } catch (error) {
    console.log(`❌ Error adding interaction with reminder: ${error.message}`)
    return {}
  }
}

async function setReminder() {
  try {
    const contacts = await getRelationships()
    if (contacts.length === 0) {
      await CommandBar.prompt("No contacts", "Create a Contact first.", ["OK"])
      return
    }

    // Use showOptions for contact so the user can fuzzy-search through large lists
    const contactChoice = await CommandBar.showOptions(
      contacts.map((c) => c.name),
      "Select contact to remind"
    )
    const contact = contacts[contactChoice.index]

    const whenOptions = ["Today", "Tomorrow", "Next week", "In 2 weeks", "Next month"]
    const offsetDays = [0, 1, 7, 14, 30]

    const formResult = await CommandBar.showForm({
      title: "Set Reminder for " + contact.name,
      submitText: "Set",
      fields: [
        {
          type: "string",
          key: "when",
          title: "When",
          choices: whenOptions,
          required: true,
        },
        {
          type: "string",
          key: "text",
          title: "Reminder",
          placeholder: "What's the reminder?",
        },
      ],
    })

    if (!formResult.submitted) return {}

    const whenIndex = whenOptions.indexOf(formResult.values.when)
    const reminderDate = new Date()
    reminderDate.setDate(reminderDate.getDate() + offsetDays[whenIndex])

    scheduleCalendarReminder(
      `${contact.name}: ${formResult.values.text || "Follow up"}`,
      reminderDate,
      contact.filename
    )

    await CommandBar.prompt(
      "Reminder set!",
      `Reminder for ${contact.name} set`,
      ["OK"]
    )

    await refreshDashboardIfOpen()
    return {}
  } catch (error) {
    console.log(`❌ Error setting reminder: ${error.message}`)
    return {}
  }
}

async function updateSettings() {
  try {
    const currentTag = getSetting("crm-relationship-tag", SETTINGS.relationshipTag)
    const currentFolder = getSetting("crm-data-folder", SETTINGS.dataFolder)
    const currentCustomCats = getSetting("crm-custom-categories", "")
    const currentInteractionTypes = getSetting("crm-interaction-types", "")
    const currentNav = getSetting("crm-navigate-after-interaction", "true")
    const currentDt = getSetting("crm-interaction-datetime", "Date + Time")
    const currentPos = getSetting("crm-interaction-position", "append")
    const currentBackend = getSetting("crm-reminder-backend", "Reminders")
    const currentReminderPrefix = getSetting("crm-reminder-prefix", "Follow up with")
    const currentReminderTag = getSetting("crm-reminder-tag", "")

    const formResult = await CommandBar.showForm({
      title: "CRM Settings",
      submitText: "Save",
      fields: [
        {
          type: "string",
          key: "folder",
          title: "CRM folder",
          placeholder: "@CRM",
          default: currentFolder,
          description: "The NotePlan folder where contact notes are stored. You can use a nested path, e.g. Work/CRM.",
          required: true,
        },
        {
          type: "string",
          key: "tag",
          title: "Contact tag prefix",
          placeholder: "contact",
          default: currentTag,
          description: "The hashtag prefix used to categorise contacts (e.g. 'contact' produces #contact/Client).",
          required: true,
        },
        {
          type: "string",
          key: "customCategories",
          title: "Custom categories",
          placeholder: "Mentor, Investor, Partner",
          default: currentCustomCats,
          description: "Additional categories beyond Client, Colleague, Friend, Family. Comma-separated.",
        },
        {
          type: "string",
          key: "interactionTypes",
          title: "Interaction types",
          placeholder: "☎️ Call, 📧 Email, 🤝 Meeting, 💬 Text, 📱 Social, 📝 Other",
          default: currentInteractionTypes,
          description: "Comma-separated list of interaction types. Leave empty to use the defaults.",
        },
        {
          type: "string",
          key: "datetime",
          title: "Timestamp format",
          choices: ["Date Only", "Date + Time"],
          default: currentDt,
          required: true,
        },
        {
          type: "string",
          key: "position",
          title: "Interaction position in note",
          choices: ["append", "prepend"],
          default: currentPos,
          required: true,
          description: "append = newest at bottom, prepend = newest at top (below ## Interactions heading).",
        },
        {
          type: "bool",
          key: "navigate",
          title: "Open contact note after logging interaction",
          default: currentNav === "true",
        },
        {
          type: "string",
          key: "backend",
          title: "Reminder backend",
          choices: ["Reminders", "NotePlan"],
          default: currentBackend,
          required: true,
          description: "Reminders = Apple Reminders (native notifications). NotePlan = tasks inside the contact note.",
        },
        {
          type: "string",
          key: "reminderPrefix",
          title: "Reminder message prefix",
          placeholder: "Follow up with",
          default: currentReminderPrefix,
          description: "Text before the contact name in automatic reminders.",
        },
        {
          type: "string",
          key: "reminderTag",
          title: "Reminder tag",
          placeholder: "#follow-up",
          default: currentReminderTag,
          description: "Optional tag appended to reminder titles. Leave empty for none.",
        },
      ],
    })

    if (!formResult.submitted) return

    const v = formResult.values

    // If backend is Reminders, ask which list to use
    let listVal = ""
    if (v.backend === "Reminders") {
      const reminderLists = Calendar.availableReminderListTitles()
      if (reminderLists && reminderLists.length > 0) {
        const currentList = getSetting("crm-reminder-list", "")
        const listOptions = ["Default (system default)", ...reminderLists]
        const defaultList = currentList && reminderLists.includes(currentList) ? currentList : "Default (system default)"
        const listForm = await CommandBar.showForm({
          title: "Reminder List",
          submitText: "Save",
          fields: [
            {
              type: "string",
              key: "list",
              title: "Which Reminders list should CRM use?",
              choices: listOptions,
              default: defaultList,
              required: true,
            },
          ],
        })
        if (listForm.submitted && listForm.values.list !== "Default (system default)") {
          listVal = listForm.values.list
        }
      }
    }

    // Save settings via DataStore.settings
    DataStore.settings = {
      ...DataStore.settings,
      "crm-relationship-tag": v.tag || currentTag,
      "crm-navigate-after-interaction": v.navigate ? "true" : "false",
      "crm-interaction-datetime": v.datetime,
      "crm-interaction-position": v.position,
      "crm-reminder-backend": v.backend,
      "crm-reminder-list": listVal,
      "crm-data-folder": v.folder || currentFolder,
      "crm-custom-categories": v.customCategories != null ? v.customCategories : currentCustomCats,
      "crm-interaction-types": v.interactionTypes != null ? v.interactionTypes : currentInteractionTypes,
      "crm-reminder-prefix": v.reminderPrefix || currentReminderPrefix,
      "crm-reminder-tag": v.reminderTag != null ? v.reminderTag.trim() : currentReminderTag,
    }

    await refreshDashboardIfOpen()
  } catch (error) {
    console.log(`❌ Error updating settings: ${error.message}`)
  }
}

// HELPER FUNCTIONS

function getDataFolder() {
  return getSetting("crm-data-folder", SETTINGS.dataFolder)
}

function buildReminderTitle(contactName) {
  const prefix = getSetting("crm-reminder-prefix", "Follow up with")
  const tag = getSetting("crm-reminder-tag", "")
  const tagSuffix = tag && tag.trim() ? " " + tag.trim() : ""
  return `${prefix} ${contactName}${tagSuffix}`
}

function getRelationships() {
  try {
    
    const folderNotes = DataStore.projectNotes.filter(
      (n) => n.filename && n.filename.startsWith(getDataFolder() + "/")
    )

    // Get the current tag prefix from settings
    const tagPrefix = getSetting("crm-relationship-tag", SETTINGS.relationshipTag)
    const requiredTagPrefix = tagPrefix + "/"

    const relationships = folderNotes
      .map((note) => {
        // Verify that it is a valid contact (has the configured tag in frontmatter)
        const fm = parseFrontmatter(note.content)
        if (!fm.tags || !fm.tags.includes(requiredTagPrefix)) return null
        const rel = parseContactNote(note)
        if (!rel) return null
        return { name: note.title, filename: note.filename, ...rel }
      })
      .filter(Boolean)

    return relationships
  } catch (error) {
    console.log(`❌ Error getting relationships: ${error.message}`)
    return []
  }
}

// Returns {key: value} for all fields in a YAML frontmatter block
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}
  const result = {}
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^([\w_-]+):\s*(.*)$/)
    if (kv) result[kv[1]] = kv[2].trim()
  }
  return result
}

// Returns note.content with a frontmatter key updated (or added)
function updateFrontmatterKey(content, key, value) {
  const fm = content.match(/^---\n([\s\S]*?)\n---/)
  if (!fm) return content
  const existing = new RegExp(`^${key}:.*$`, "m")
  const updated = existing.test(fm[1])
    ? fm[1].replace(existing, `${key}: ${value}`)
    : fm[1] + `\n${key}: ${value}`
  return content.replace(fm[0], `---\n${updated}\n---`)
}

function parseContactNote(note) {
  try {
    const fm = parseFrontmatter(note.content)
    return {
      category: fm.category || "",
      frequency: fm.frequency || "",
      frequencyKey: fm.frequency_key || "",
      lastContact: fm.last_contact || "",
    }
  } catch (error) {
    console.log(`⚠️ Error parsing contact note: ${error.message}`)
    return null
  }
}

function createContactNote(name, category, frequency, frequencyKey, tagPrefix) {
  const tag = tagPrefix || SETTINGS.relationshipTag
  return `---
category: ${category}
frequency: ${frequency}
frequency_key: ${frequencyKey}
last_contact: Never
tags: ${tag}/${category}
---
# ${name}

## Photo

## Tasks

## Interactions
`
}

function scheduleCalendarReminder(title, date, noteFilename) {
  const backend = getSetting("crm-reminder-backend", "Reminders")
  if (backend === "NotePlan") {
    scheduleNoteplanTask(title, date, noteFilename)
  } else {
    scheduleAppleReminder(title, date, noteFilename)
  }
}

function scheduleAppleReminder(title, date, noteFilename) {
  try {
    const list = getSetting("crm-reminder-list", "")
    const item = CalendarItem.create(
      title, date, null, "reminder", false, list || "", false,
      `From CRM: ${noteFilename}`
    )
    Calendar.add(item)
  } catch (error) {
    console.log(`❌ Error scheduling Apple reminder: ${error.message}`)
  }
}

function scheduleNoteplanTask(title, date, noteFilename) {
  try {
    const filename = noteFilename
    const note = DataStore.projectNoteByFilename(filename)
    if (!note) {
      console.log(`❌ Could not open note for NP task: ${filename}`)
      return
    }

    const dateStr = formatDate(date)
    const taskText = `${title} >${dateStr}`

    const tasksHeading = note.paragraphs.find(
      p => p.type === "title" && p.content.trim() === "Tasks"
    )
    if (tasksHeading) {
      note.insertParagraph(taskText, tasksHeading.lineIndex + 1, "open")
    } else {
      note.appendParagraph("## Tasks", "empty")
      note.appendParagraph(taskText, "open")
    }
  } catch (error) {
    console.log(`❌ Error scheduling NotePlan task: ${error.message}`)
  }
}

function scheduleNextReminder(contactName, frequencyKey, noteFilename) {
  const date = getNextReminderDate(frequencyKey)
  const filename = noteFilename || `${getDataFolder()}/${contactName}.md`
  scheduleCalendarReminder(buildReminderTitle(contactName), date, filename)
}

async function completeContactReminder(contactName) {
  const backend = getSetting("crm-reminder-backend", "Reminders")
  if (backend === "NotePlan") {
    completeNoteplanTask(contactName)
  } else {
    await completeAppleReminder(contactName)
  }
}

async function completeAppleReminder(contactName) {
  try {
    const from = new Date()
    from.setFullYear(from.getFullYear() - 2)
    const to = new Date()
    to.setFullYear(to.getFullYear() + 2)

    const allReminders = await Calendar.remindersBetween(from, to, '')
    
    const contactReminders = allReminders.filter((r) =>
      r.title.toLowerCase().includes(contactName.toLowerCase()) &&
      !r.isCompleted
    )

    for (const reminder of contactReminders) {
      reminder.isCompleted = true
      await Calendar.update(reminder)
    }
  } catch (error) {
    console.log(`⚠️ Could not complete Apple reminder: ${error.message}`)
  }
}

function completeNoteplanTask(contactName) {
  try {
    const folderNotes = DataStore.projectNotes.filter(
      (n) => n.filename && n.filename.startsWith(getDataFolder() + "/")
    )
    for (const note of folderNotes) {
      if (!note.title || note.title.toLowerCase() !== contactName.toLowerCase()) continue
      for (const p of note.paragraphs) {
        if (p.type === "open" && p.content.toLowerCase().includes(contactName.toLowerCase())) {
          p.type = "done"
          note.updateParagraph(p)
        }
      }
      break
    }
  } catch (error) {
    console.log(`⚠️ Could not complete NotePlan task: ${error.message}`)
  }
}

async function refreshDashboard() {
  try {
    const contacts = await getRelationships()
    const html = getCRMDashboardHTML(contacts)
    await HTMLView.showInMainWindow(html, "CRM Dashboard", {
      customId: WINDOW_ID,
      splitView: false,
      icon: "users",
      iconColor: "blue-500",
      autoTopPadding: true,
    })
  } catch (error) {
    console.log(`⚠️ Could not refresh dashboard: ${error.message}`)
  }
}

// Refresh the dashboard only if it is already open, without navigating to it
async function refreshDashboardIfOpen() {
  try {
    const dashWindow = NotePlan.htmlWindows.find(w => w.customId === WINDOW_ID)
    if (!dashWindow) return
    const contacts = await getRelationships()
    const contactsJSON = JSON.stringify(contacts || [])
      .replace(/</g, "\\u003c")
      .replace(/>/g, "\\u003e")
    const reminderList = getSetting("crm-reminder-list", "")
    const reminderListJSON = JSON.stringify(reminderList)
    const reminderBackend = getSetting("crm-reminder-backend", "Reminders")
    const reminderBackendJSON = JSON.stringify(reminderBackend)
    const npTasks = reminderBackend === "NotePlan" ? getCRMTasks() : []
    const npTasksJSON = JSON.stringify(npTasks)
      .replace(/</g, "\\u003c")
      .replace(/>/g, "\\u003e")
    await dashWindow.runJavaScript(
      "if (typeof updateContacts === 'function') { updateContacts(" + contactsJSON + ", " + reminderListJSON + ", " + reminderBackendJSON + ", " + npTasksJSON + "); }"
    )
  } catch (error) {
    console.log(`⚠️ Could not refresh dashboard in place: ${error.message}`)
  }
}

function getCRMTasks() {
  try {
    const folderNotes = DataStore.projectNotes.filter(
      (n) => n.filename && n.filename.startsWith(getDataFolder() + "/")
    )
    const tasks = []
    for (const note of folderNotes) {
      for (const p of note.paragraphs) {
        if (p.type !== "open") continue
        const dateMatch = p.content.match(/>(\d{4}-\d{2}-\d{2})/)
        if (!dateMatch) continue
        const title = p.content.replace(/>(\d{4}-\d{2}-\d{2})/, "").trim()
        tasks.push({
          title: title,
          date: dateMatch[1],
          contact: note.title || "",
          filename: note.filename,
        })
      }
    }
    tasks.sort(function(a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0 })
    return tasks
  } catch (error) {
    console.log(`❌ Error getting CRM tasks: ${error.message}`)
    return []
  }
}

function getNextReminderDate(frequencyKey) {
  const date = new Date()
  const frequencyMap = {
    day: 1,
    week: 7,
    twoWeeks: 14,
    threeWeeks: 21,
    month: 30,
    twoMonths: 60,
    quarter: 90,
    sixMonths: 180,
    year: 365,
  }
  date.setDate(date.getDate() + (frequencyMap[frequencyKey] || 30))
  return date
}

function formatDate(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function formatDateTime(date) {
  let value = getSetting("crm-interaction-datetime", "Date + Time")
  if (typeof value === "boolean" || value === "true" || value === "false") {
    value = (value === true || value === "true") ? "Date + Time" : "Date Only"
  }
  const showTime = value === "Date + Time"
  const dateStr = formatDate(date)
  if (!showTime) return dateStr
  const hours = String(date.getHours()).padStart(2, "0")
  const minutes = String(date.getMinutes()).padStart(2, "0")
  return `${dateStr} | ${hours}:${minutes}`
}

// CRM DASHBOARD HTML

function getCRMDashboardHTML(contacts) {
  const contactsJSON = JSON.stringify(contacts || [])
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")

  const reminderList = getSetting("crm-reminder-list", "")
  const reminderListJSON = JSON.stringify(reminderList)

  const reminderBackend = getSetting("crm-reminder-backend", "Reminders")
  const reminderBackendJSON = JSON.stringify(reminderBackend)

  const npTasks = reminderBackend === "NotePlan" ? getCRMTasks() : []
  const npTasksJSON = JSON.stringify(npTasks)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CRM Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif;
      background-color: #fff;
      color: #333;
      padding: 20px;
    }
    @media (prefers-color-scheme: dark) {
      body { background-color: #1c1c1e; color: #f5f5f5; }
    }
    .container { max-width: 900px; margin: 0 auto; }
    h1 { font-size: 28px; margin-bottom: 6px; font-weight: 700; }
    .subtitle { font-size: 13px; color: #888; margin-bottom: 24px; }

    .action-buttons {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 8px;
      margin-bottom: 28px;
      padding: 16px;
      background: #f5f5f7;
      border-radius: 10px;
    }
    @media (prefers-color-scheme: dark) {
      .action-buttons { background: #2c2c2e; }
    }
    
    .btn {
      padding: 10px 16px;
      background: #007AFF;
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    .btn:hover { background: #0051D5; }
    .btn:active { background: #003FA8; }
    
    .btn-secondary {
      background: #666;
    }
    .btn-secondary:hover { background: #555; }
    .btn-secondary:active { background: #444; }

    .stats {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
      margin-bottom: 28px;
    }
    .stat-card {
      background: #f5f5f7;
      padding: 16px 20px;
      border-radius: 10px;
      text-align: center;
    }
    @media (prefers-color-scheme: dark) { .stat-card { background: #2c2c2e; } }
    .stat-value { font-size: 26px; font-weight: 700; color: #007AFF; }
    .stat-label { font-size: 11px; color: #888; margin-top: 6px; text-transform: uppercase; letter-spacing: 0.5px; }

    .section { margin-bottom: 32px; }
    .section-title {
      font-size: 16px; font-weight: 700;
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 2px solid #007AFF;
    }

    .list { display: flex; flex-direction: column; gap: 8px; }

    .card {
      background: #f5f5f7;
      padding: 14px 16px;
      border-radius: 8px;
      border-left: 4px solid #007AFF;
      cursor: pointer;
      transition: background 0.2s;
    }
    .card:hover { background: #ececf0; }
    @media (prefers-color-scheme: dark) {
      .card { background: #2c2c2e; }
      .card:hover { background: #3a3a3d; }
    }

    .card-title { font-weight: 600; font-size: 14px; margin-bottom: 4px; }
    .card-meta { font-size: 12px; color: #888; display: flex; gap: 14px; flex-wrap: wrap; }

    .empty { text-align: center; color: #888; padding: 32px 20px; font-size: 14px; }
    .loading { text-align: center; padding: 20px; color: #888; }

    .filter-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 12px;
    }
    .filter-btn {
      padding: 5px 12px;
      border: 1.5px solid #007AFF;
      border-radius: 20px;
      background: transparent;
      color: #007AFF;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
    }
    .filter-btn:hover { background: #e5f0ff; }
    .filter-btn.active { background: #007AFF; color: white; }
    @media (prefers-color-scheme: dark) {
      .filter-btn { color: #4da3ff; border-color: #4da3ff; }
      .filter-btn:hover { background: #1a2f4a; }
      .filter-btn.active { background: #4da3ff; color: #1c1c1e; }
    }
  </style>
</head>
<body>
<div class="container">

  <div class="action-buttons">
    <button class="btn" onclick="addInteractionFromDashboard()">📝 Log Interaction</button>
    <button class="btn" onclick="addInteractionWithReminderFromDashboard()">🔔 Log & Remind</button>
    <button class="btn" onclick="addReminderFromDashboard()">⏰ Set Reminder</button>
    <button class="btn" onclick="addContactFromDashboard()">👤 Add Contact</button>
  </div>

  <div class="stats">
    <div class="stat-card">
      <div class="stat-value" id="totalContacts">—</div>
      <div class="stat-label">Contacts</div>
    </div>
    <div class="stat-card">
      <div class="stat-value" id="upcomingReminders">—</div>
      <div class="stat-label">This Week</div>
    </div>
    <div class="stat-card">
      <div class="stat-value" id="overdueCount">—</div>
      <div class="stat-label">Overdue</div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">📅 Upcoming Reminders</div>
    <div class="list" id="reminders">
      <div class="loading">Loading…</div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">👥 Contacts</div>
    <div class="filter-bar" id="categoryFilters"></div>
    <div class="list" id="contacts">
      <div class="loading">Loading…</div>
    </div>
  </div>
</div>

<script>
  // Data injected by the plugin
  var CONTACTS = ${contactsJSON};
  var REMINDER_LIST = ${reminderListJSON};
  var REMINDER_BACKEND = ${reminderBackendJSON};
  var NP_TASKS = ${npTasksJSON};
  var activeFilter = 'All';

  // ──────────────────────────────────────────────────────────────────────────
  // CATEGORY FILTER
  // ──────────────────────────────────────────────────────────────────────────

  function buildCategoryFilters() {
    var categories = ['All'];
    CONTACTS.forEach(function(c) {
      if (c.category && categories.indexOf(c.category) === -1) {
        categories.push(c.category);
      }
    });

    var bar = document.getElementById('categoryFilters');
    if (categories.length <= 1) {
      bar.style.display = 'none';
      return;
    }

    var html = '';
    for (var i = 0; i < categories.length; i++) {
      var cat = categories[i];
      var cls = cat === activeFilter ? 'filter-btn active' : 'filter-btn';
      html += '<button class="' + cls + '" data-cat="' + esc(cat) + '">'
        + esc(cat) + '</button>';
    }
    bar.innerHTML = html;

    var btns = bar.querySelectorAll('.filter-btn');
    for (var j = 0; j < btns.length; j++) {
      (function(btn) {
        btn.addEventListener('click', function() {
          setFilter(btn.getAttribute('data-cat'));
        });
      })(btns[j]);
    }
  }

  function setFilter(category) {
    activeFilter = category;
    buildCategoryFilters();
    renderContacts();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // BUTTON FUNCTIONS
  // ──────────────────────────────────────────────────────────────────────────

  async function addInteractionFromDashboard() {
    await DataStore.invokePluginCommandByName('Log Interaction', 'np.jokky102.crm', []);
  }

  async function addInteractionWithReminderFromDashboard() {
    await DataStore.invokePluginCommandByName('Log Interaction & Schedule Reminder', 'np.jokky102.crm', []);
  }

  async function addReminderFromDashboard() {
    await DataStore.invokePluginCommandByName('Set Reminder', 'np.jokky102.crm', []);
  }

  async function addContactFromDashboard() {
    await DataStore.invokePluginCommandByName('Add Contact', 'np.jokky102.crm', []);
  }

  function openContact(el) {
    var filename = el.getAttribute('data-filename');
    if (filename) Editor.openNoteByFilename(filename);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // RENDER
  // ──────────────────────────────────────────────────────────────────────────

  function renderContacts() {
    var el = document.getElementById('contacts');
    document.getElementById('totalContacts').textContent = CONTACTS.length;

    var filtered = activeFilter === 'All'
      ? CONTACTS
      : CONTACTS.filter(function(c) { return c.category === activeFilter; });

    if (filtered.length === 0) {
      el.innerHTML = CONTACTS.length === 0
        ? '<div class="empty">No contacts yet.<br>Use "Add Contact" button to create one.</div>'
        : '<div class="empty">No contacts in category "' + esc(activeFilter) + '".</div>';
      return;
    }

    el.innerHTML = filtered.map(function(c) {
      return '<div class="card" data-filename="' + esc(c.filename) + '" onclick="openContact(this)">' +
        '<div class="card-title">' + esc(c.name) + '</div>' +
        '<div class="card-meta">' +
          (c.category ? '<span>🏷️ ' + esc(c.category) + '</span>' : '') +
          '<span>📅 ' + esc(c.frequency || 'Monthly') + '</span>' +
          '<span>💬 Last: ' + esc(c.lastContact || 'Never') + '</span>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  async function renderReminders() {
    var el = document.getElementById('reminders');

    if (REMINDER_BACKEND === 'NotePlan') {
      renderNoteplanTasks(el);
      return;
    }

    try {
      var now = new Date();
      var todayStart = new Date(now);
      todayStart.setHours(0, 0, 0, 0);
      var todayEnd = new Date(now);
      todayEnd.setHours(23, 59, 59, 999);

      var pastStart = new Date(todayStart);
      pastStart.setFullYear(pastStart.getFullYear() - 2);
      var yesterdayEnd = new Date(todayStart);
      yesterdayEnd.setMilliseconds(yesterdayEnd.getMilliseconds() - 1);

      function isCrmReminder(r) {
        if (!r.notes || !r.notes.startsWith('From CRM:')) return false;
        if (REMINDER_LIST && r.calendar !== REMINDER_LIST) return false;
        return !r.isCompleted;
      }

      var overdueRaw = (await Calendar.remindersBetween(pastStart, yesterdayEnd, '')).filter(isCrmReminder);

      var endOfWeek = new Date(todayStart);
      endOfWeek.setDate(endOfWeek.getDate() + (6 - todayStart.getDay()));
      endOfWeek.setHours(23, 59, 59, 999);

      var upcoming = (await Calendar.remindersBetween(todayStart, endOfWeek, '')).filter(isCrmReminder);

      document.getElementById('upcomingReminders').textContent = upcoming.length;
      document.getElementById('overdueCount').textContent = overdueRaw.length;

      var html = '';

      if (overdueRaw.length > 0) {
        html += '<div style="font-size:11px;font-weight:700;color:#FF3B30;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">⚠️ Overdue</div>';
        html += overdueRaw.map(function(r) {
          return '<div class="card" style="border-left:3px solid #FF3B30;">' +
            '<div class="card-title">' + esc(r.title) + '</div>' +
            '<div class="card-meta"><span style="color:#FF3B30;">' + new Date(r.date).toLocaleDateString() + '</span></div>' +
          '</div>';
        }).join('');
      }

      if (upcoming.length > 0) {
        if (overdueRaw.length > 0) {
          html += '<div style="font-size:11px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:0.5px;margin:12px 0 6px;">📅 This week</div>';
        }
        html += upcoming.map(function(r) {
          return '<div class="card">' +
            '<div class="card-title">' + esc(r.title) + '</div>' +
            '<div class="card-meta"><span>' + new Date(r.date).toLocaleDateString() + '</span></div>' +
          '</div>';
        }).join('');
      }

      if (html === '') {
        el.innerHTML = '<div class="empty">No reminders this week 🎉</div>';
      } else {
        el.innerHTML = html;
      }

    } catch (e) {
      el.innerHTML = '<div class="empty">Could not load reminders: ' + esc(e.message) + '</div>';
      document.getElementById('upcomingReminders').textContent = '?';
      document.getElementById('overdueCount').textContent = '?';
    }
  }

  function renderNoteplanTasks(el) {
    var now = new Date();
    var todayStr = now.getFullYear() + '-' +
      String(now.getMonth() + 1).padStart(2, '0') + '-' +
      String(now.getDate()).padStart(2, '0');
    var todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);

    var endOfWeek = new Date(todayStart);
    endOfWeek.setDate(endOfWeek.getDate() + (6 - todayStart.getDay()));
    var endOfWeekStr = endOfWeek.getFullYear() + '-' +
      String(endOfWeek.getMonth() + 1).padStart(2, '0') + '-' +
      String(endOfWeek.getDate()).padStart(2, '0');

    var overdue = [];
    var upcoming = [];

    for (var i = 0; i < NP_TASKS.length; i++) {
      var t = NP_TASKS[i];
      if (t.date < todayStr) overdue.push(t);
      else if (t.date <= endOfWeekStr) upcoming.push(t);
    }

    document.getElementById('upcomingReminders').textContent = upcoming.length;
    document.getElementById('overdueCount').textContent = overdue.length;

    var html = '';

    if (overdue.length > 0) {
      html += '<div style="font-size:11px;font-weight:700;color:#FF3B30;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">⚠️ Overdue</div>';
      html += overdue.map(function(t) {
        return '<div class="card" style="border-left:3px solid #FF3B30;">' +
          '<div class="card-title">' + esc(t.title) + '</div>' +
          '<div class="card-meta"><span style="color:#FF3B30;">' + esc(t.date) + '</span>' +
          (t.contact ? ' <span>👤 ' + esc(t.contact) + '</span>' : '') + '</div></div>';
      }).join('');
    }

    if (upcoming.length > 0) {
      if (overdue.length > 0) {
        html += '<div style="font-size:11px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:0.5px;margin:12px 0 6px;">📅 This week</div>';
      }
      html += upcoming.map(function(t) {
        return '<div class="card">' +
          '<div class="card-title">' + esc(t.title) + '</div>' +
          '<div class="card-meta"><span>' + esc(t.date) + '</span>' +
          (t.contact ? ' <span>👤 ' + esc(t.contact) + '</span>' : '') + '</div></div>';
      }).join('');
    }

    if (html === '') {
      el.innerHTML = '<div class="empty">No tasks this week 🎉</div>';
    } else {
      el.innerHTML = html;
    }
  }

  function esc(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function init() {
    buildCategoryFilters();
    renderContacts();

    if (typeof Calendar !== 'undefined') {
      await renderReminders();
    } else {
      window.addEventListener('notePlanBridgeReady', function() {
        renderReminders();
      }, { once: true });
      setTimeout(function() {
        if (typeof Calendar !== 'undefined') renderReminders();
        else {
          document.getElementById('reminders').innerHTML =
            '<div class="empty">Calendar API not available</div>';
          document.getElementById('upcomingReminders').textContent = '—';
          document.getElementById('overdueCount').textContent = '—';
        }
      }, 2500);
    }
  }

  // Called by the plugin via runJavaScript to update data without reloading the page
  function updateContacts(newContacts, newReminderList, newBackend, newNpTasks) {
    CONTACTS = newContacts;
    if (newReminderList !== undefined) REMINDER_LIST = newReminderList;
    if (newBackend !== undefined) REMINDER_BACKEND = newBackend;
    if (newNpTasks !== undefined) NP_TASKS = newNpTasks;
    buildCategoryFilters();
    renderContacts();
    renderReminders();
  }

  window.addEventListener('load', init);
</script>
</body>
</html>`;
}