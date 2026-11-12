import { updateWorkspaceBusinessSettingsAction } from '@/app/actions/crm';
import type { BusinessKnowledgeSettings } from '@/lib/knowledge/business-settings';

export function BusinessSettingsForm({
  settings,
  isOwner,
}: {
  settings: BusinessKnowledgeSettings;
  isOwner: boolean;
}) {
  if (!isOwner) {
    return (
      <section
        role="alert"
        className="bg-red-50 border border-red-200 rounded-xl p-6 text-sm text-red-950 space-y-2"
      >
        <div className="font-bold text-base">Owner-Only Business Settings</div>
        <p>
          Only the workspace <strong>owner</strong> ({settings.founder_name}) is permitted to view or
          update services, FAQs, pricing rules, callback hours, and escalation contacts.
        </p>
      </section>
    );
  }

  const fs = settings.founder_settings;
  const faqs = settings.approved_faqs;

  return (
    <form action={updateWorkspaceBusinessSettingsAction} className="space-y-6">
      {/* 1. Business Profile */}
      <section className="bg-white border border-[#E2E8E2] rounded-xl p-6 space-y-4">
        <div className="flex items-center justify-between border-b border-[#E2E8E2] pb-3">
          <div>
            <h2 className="text-base font-bold text-[#0B1220]">
              1. Business Profile &amp; Service Catalog
            </h2>
            <p className="text-xs text-slate-600">
              Shared automatically between Outbound Sales Agent Nila and Founder Assistant Nila.
            </p>
          </div>
          <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-[#149642]/15 text-[#0F7633]">
            Owner Editable
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <div>
            <label className="block text-xs font-semibold uppercase text-slate-700 mb-1">
              Business Name
            </label>
            <input
              name="business_name"
              defaultValue={settings.business_name}
              className="w-full rounded-lg border border-[#E2E8E2] px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase text-slate-700 mb-1">
              Founder / MD
            </label>
            <input
              name="founder_name"
              defaultValue={settings.founder_name}
              className="w-full rounded-lg border border-[#E2E8E2] px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase text-slate-700 mb-1">
              Location
            </label>
            <input
              name="location"
              defaultValue={settings.location}
              className="w-full rounded-lg border border-[#E2E8E2] px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase text-slate-700 mb-1">
              Website
            </label>
            <input
              name="website"
              defaultValue={settings.website}
              className="w-full rounded-lg border border-[#E2E8E2] px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase text-slate-700 mb-1">
              Positioning
            </label>
            <input
              name="positioning"
              defaultValue={settings.positioning}
              className="w-full rounded-lg border border-[#E2E8E2] px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase text-slate-700 mb-1">
              Default Conversation Language
            </label>
            <input
              name="default_language"
              defaultValue={settings.default_language}
              className="w-full rounded-lg border border-[#E2E8E2] px-3 py-2 text-sm"
            />
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs font-semibold uppercase text-slate-700 mb-1">
              First Pilot Priority Service
            </label>
            <input
              name="pilot_primary_service"
              defaultValue={settings.pilot_primary_service}
              className="w-full rounded-lg border border-[#E2E8E2] px-3 py-2 text-sm"
            />
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs font-semibold uppercase text-slate-700 mb-1">
              Service Catalog (One Service Per Line)
            </label>
            <textarea
              name="service_catalog"
              rows={6}
              defaultValue={settings.service_catalog.join('\n')}
              className="w-full rounded-lg border border-[#E2E8E2] px-3 py-2 text-sm font-mono"
            />
          </div>
        </div>
      </section>

      {/* 2. Founder Settings (Left Blank Until Filled In) */}
      <section className="bg-white border border-[#E2E8E2] rounded-xl p-6 space-y-4">
        <div className="border-b border-[#E2E8E2] pb-3">
          <h2 className="text-base font-bold text-[#0B1220]">
            2. Founder Settings (Blank by Default Until Configured)
          </h2>
          <p className="text-xs text-slate-600">
            If any field below is left blank, Nila states that the team can clarify it and never
            invents prices, offer terms, availability, testimonials, or expected results. Agency fees
            and ad spend are always kept distinct.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <div>
            <label className="block text-xs font-semibold uppercase text-slate-700 mb-1">
              Approved Service Fees or Quote Ranges
            </label>
            <input
              name="approved_service_fees"
              defaultValue={fs.approved_service_fees}
              placeholder="Leave blank until approved (team will clarify)"
              className="w-full rounded-lg border border-[#E2E8E2] px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase text-slate-700 mb-1">
              Minimum Ad Budget, If Any
            </label>
            <input
              name="minimum_ad_budget"
              defaultValue={fs.minimum_ad_budget}
              placeholder="Leave blank until approved"
              className="w-full rounded-lg border border-[#E2E8E2] px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase text-slate-700 mb-1">
              Whether a Discovery Call Is Free or Paid
            </label>
            <input
              name="discovery_call_fee_policy"
              defaultValue={fs.discovery_call_fee_policy}
              placeholder="Leave blank until approved"
              className="w-full rounded-lg border border-[#E2E8E2] px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase text-slate-700 mb-1">
              Callback Days, Available Time Slots &amp; Meeting Duration
            </label>
            <input
              name="callback_schedule"
              defaultValue={fs.callback_schedule}
              placeholder="Leave blank to queue callback requests for founder review"
              className="w-full rounded-lg border border-[#E2E8E2] px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase text-slate-700 mb-1">
              Escalation Contacts (Founder / Team Member per Enquiry Type)
            </label>
            <input
              name="escalation_contacts"
              defaultValue={fs.escalation_contacts}
              placeholder="Leave blank until assigned"
              className="w-full rounded-lg border border-[#E2E8E2] px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase text-slate-700 mb-1">
              Service Locations &amp; Any Exclusions
            </label>
            <input
              name="service_locations_and_exclusions"
              defaultValue={fs.service_locations_and_exclusions}
              placeholder="Leave blank until configured"
              className="w-full rounded-lg border border-[#E2E8E2] px-3 py-2 text-sm"
            />
          </div>

          <div className="md:col-span-2">
            <label className="block text-xs font-semibold uppercase text-slate-700 mb-1">
              Approved Client Examples, Results &amp; Testimonials
            </label>
            <textarea
              name="approved_proof_points"
              rows={2}
              defaultValue={fs.approved_proof_points}
              placeholder="Leave blank until approved (never invented)"
              className="w-full rounded-lg border border-[#E2E8E2] px-3 py-2 text-sm"
            />
          </div>
        </div>
      </section>

      {/* 3. Approved Responses to Common Questions */}
      <section className="bg-white border border-[#E2E8E2] rounded-xl p-6 space-y-4">
        <div className="border-b border-[#E2E8E2] pb-3">
          <h2 className="text-base font-bold text-[#0B1220]">
            3. Approved Responses to Common Questions (FAQs)
          </h2>
          <p className="text-xs text-slate-600">
            Used verbatim by Nila during outbound calls and assistant sessions.
          </p>
        </div>

        <div className="space-y-3 text-sm">
          <div>
            <label className="block text-xs font-semibold uppercase text-slate-700 mb-1">
              &ldquo;How much do you charge?&rdquo;
            </label>
            <input
              name="how_much_do_you_charge"
              defaultValue={faqs.how_much_do_you_charge}
              className="w-full rounded-lg border border-[#E2E8E2] px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase text-slate-700 mb-1">
              &ldquo;Can you guarantee leads or sales?&rdquo;
            </label>
            <input
              name="can_you_guarantee_leads_or_sales"
              defaultValue={faqs.can_you_guarantee_leads_or_sales}
              className="w-full rounded-lg border border-[#E2E8E2] px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase text-slate-700 mb-1">
              &ldquo;We already have an agency.&rdquo;
            </label>
            <input
              name="we_already_have_an_agency"
              defaultValue={faqs.we_already_have_an_agency}
              className="w-full rounded-lg border border-[#E2E8E2] px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase text-slate-700 mb-1">
              &ldquo;Just send me the details.&rdquo;
            </label>
            <input
              name="just_send_me_the_details"
              defaultValue={faqs.just_send_me_the_details}
              className="w-full rounded-lg border border-[#E2E8E2] px-3 py-2 text-sm"
            />
          </div>
        </div>
      </section>

      <div className="flex items-center justify-end">
        <button
          type="submit"
          className="px-5 py-2.5 rounded-lg bg-[#0F7633] hover:bg-[#149642] text-white text-sm font-semibold cursor-pointer"
        >
          Save Business Settings (Owner Only)
        </button>
      </div>
    </form>
  );
}

