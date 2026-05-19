'use client';

import React, { useState, useEffect } from 'react';
import { User } from 'firebase/auth';
import { initAuth, googleSignIn, logout, getAccessToken } from '@/lib/firebase';
import { Calendar, Clock, Globe, Plus, Trash2, Users, AlertCircle, CheckCircle2, ChevronRight, Play } from 'lucide-react';
import { format, addMinutes, isAfter, isBefore, setHours, setMinutes, parseISO, startOfDay } from 'date-fns';
import { formatInTimeZone, toDate } from 'date-fns-tz';

type Attendee = {
  id: string;
  name: string;
  email: string;
  timeZone: string;
  workStart: number; // Hour 0-23
  workEnd: number; // Hour 0-23
};

const COMMON_TIMEZONES = [
  { value: 'America/New_York', label: 'New York (EST/EDT)' },
  { value: 'America/Chicago', label: 'Chicago (CST/CDT)' },
  { value: 'America/Los_Angeles', label: 'Los Angeles (PST/PDT)' },
  { value: 'America/Buenos_Aires', label: 'Buenos Aires (ART)' },
  { value: 'Europe/London', label: 'London (GMT/BST)' },
  { value: 'Europe/Lisbon', label: 'Lisbon (WET/WEST)' },
  { value: 'Europe/Berlin', label: 'Berlin (CET/CEST)' },
  { value: 'Asia/Tokyo', label: 'Tokyo (JST)' },
  { value: 'Asia/Kolkata', label: 'India (IST)' },
  { value: 'Australia/Sydney', label: 'Sydney (AEST/AEDT)' },
  { value: 'UTC', label: 'UTC' }
];

export default function SchedulingAssistant() {
  const [needsAuth, setNeedsAuth] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  useEffect(() => {
    const unsubscribe = initAuth((user, token) => {
      // We only consider them fully authed for this session if we have BOTH a user AND the google access token for calendar
      if (user && token) {
        setUser(user);
        setNeedsAuth(false);
      } else {
        setUser(null);
        setNeedsAuth(true);
      }
    });
    return () => unsubscribe();
  }, []);

  const handleLogin = async () => {
    setIsLoggingIn(true);
    try {
      const result = await googleSignIn();
      if (result) {
        setUser(result.user);
        setNeedsAuth(false);
      }
    } catch (err: any) {
      console.error('Login failed:', err);
      alert('Login failed: ' + (err.message || 'Unknown error. Check console for details. (If hosting on Vercel, ensure your domain is added to Firebase Authorized Domains)'));
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    await logout();
  };

  // Form State
  const [title, setTitle] = useState('Important Sync');
  const [description, setDescription] = useState('');
  const [dateStr, setDateStr] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [duration, setDuration] = useState(60);
  const [addMeetLink, setAddMeetLink] = useState(true);
  const [attendees, setAttendees] = useState<Attendee[]>([
    { id: '1', name: 'Me', email: user?.email || '', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, workStart: 9, workEnd: 17 }
  ]);

  useEffect(() => {
    if (user && attendees[0].email === '') {
      // Just let the user manually enter their email or default it when they load the form.
      // Or we can just set it during login if necessary. To avoid infinite loops, use a layout effect or avoid direct mutation.
      const current = attendees;
      if (current[0].email === '') {
        const next = [...current];
        next[0].email = user.email || '';
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setAttendees(next);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [suggestedTimes, setSuggestedTimes] = useState<{time: Date, violations: string[]}[]>([]);
  const [selectedTimeWrapper, setSelectedTimeWrapper] = useState<{time: Date, violations: string[]} | null>(null);
  const selectedTime = selectedTimeWrapper?.time || null;
  const [isCreatingEvent, setIsCreatingEvent] = useState(false);
  const [createdEventLink, setCreatedEventLink] = useState<string | null>(null);

  const addAttendee = () => {
    setAttendees([...attendees, { 
      id: Date.now().toString(), 
      name: '', 
      email: '', 
      timeZone: COMMON_TIMEZONES[0].value, 
      workStart: 9, 
      workEnd: 17 
    }]);
  };

  const removeAttendee = (id: string) => {
    if (attendees.length > 1) {
      setAttendees(attendees.filter(a => a.id !== id));
    }
  };

  const updateAttendee = (id: string, field: keyof Attendee, value: string | number) => {
    setAttendees(attendees.map(a => a.id === id ? { ...a, [field]: value } : a));
  };

  const calculateOverlaps = () => {
    const baseDate = parseISO(dateStr);
    const options: {time: Date, violations: string[]}[] = [];
    
    // Check every hour and half hour from 0:00 to 23:30 of the selected date relative to the organizer
    for (let i = 0; i < 48; i++) {
       const timeCheck = addMinutes(startOfDay(baseDate), i * 30);
       
       const violations: string[] = [];
       for (const attendee of attendees) {
         const hourStr = formatInTimeZone(timeCheck, attendee.timeZone, 'HH');
         const minuteStr = formatInTimeZone(timeCheck, attendee.timeZone, 'mm');
         const localHourFloat = parseInt(hourStr) + parseInt(minuteStr) / 60;
         
         const endTimeFloat = localHourFloat + (duration / 60);

         if (localHourFloat < attendee.workStart || endTimeFloat > attendee.workEnd) {
           violations.push(attendee.email || attendee.name || 'someone');
         }
       }
       options.push({time: timeCheck, violations});
    }
    
    // Sort options by fewest violations
    const sortedOptions = options.sort((a, b) => {
       if (a.violations.length !== b.violations.length) {
          return a.violations.length - b.violations.length;
       }
       return a.time.getTime() - b.time.getTime();
    });

    // Take top 8 best options that have acceptable overlap
    const bestOptions = sortedOptions.slice(0, 8);
    
    setSuggestedTimes(bestOptions);
    if (bestOptions.length > 0) setSelectedTimeWrapper(bestOptions[0]);
    else setSelectedTimeWrapper(null);
    setStep(2);
    setCreatedEventLink(null);
  };

  const handleCreateInvite = async () => {
    if (!selectedTime) return;
    
    const confirmed = window.confirm('Are you sure you want to create and send this Google Calendar invite?');
    if (!confirmed) return;

    setIsCreatingEvent(true);
    try {
      const accessToken = await getAccessToken();
      if (!accessToken) throw new Error('Not authenticated');

      const startTime = selectedTime.toISOString();
      const endTime = addMinutes(selectedTime, duration).toISOString();

      const eventData = {
        summary: title,
        description: description,
        start: { dateTime: startTime },
        end: { dateTime: endTime },
        attendees: attendees.filter(a => a.email).map(a => ({ email: a.email.trim() })),
        conferenceData: addMeetLink ? {
          createRequest: {
            requestId: "meet-" + Date.now().toString(),
            conferenceSolutionKey: { type: "hangoutsMeet" }
          }
        } : undefined
      };

      const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(eventData)
      });
      
      const resData = await res.json();
      
      if (res.ok) {
        setCreatedEventLink(resData.htmlLink);
        setStep(3);
      } else {
        throw new Error(resData.error?.message || 'Failed to create event');
      }
    } catch (err: any) {
      alert('Error creating event: ' + err.message);
    } finally {
      setIsCreatingEvent(false);
    }
  };

  if (needsAuth) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-4">
        <Globe className="w-16 h-16 text-blue-500 mb-6" />
        <h2 className="text-3xl font-medium text-gray-900 mb-4 tracking-tight">Global Scheduling Assistant</h2>
        <p className="text-gray-500 mb-8 max-w-md">Connect your Google Calendar to seamlessly find overlapping working hours and schedule meetings across multiple time zones.</p>
        <button onClick={handleLogin} disabled={isLoggingIn} className="gsi-material-button shadow-sm hover:shadow-md transition-shadow">
          <div className="gsi-material-button-state"></div>
          <div className="gsi-material-button-content-wrapper flex items-center px-4 py-3 bg-white border border-gray-300 rounded-md">
            <div className="gsi-material-button-icon mr-3">
              <svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" className="w-5 h-5 block">
                <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"></path>
                <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"></path>
                <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"></path>
                <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"></path>
                <path fill="none" d="M0 0h48v48H0z"></path>
              </svg>
            </div>
            <span className="gsi-material-button-contents font-medium text-gray-700">{isLoggingIn ? 'Connecting...' : 'Sign in with Google'}</span>
          </div>
        </button>
      </div>
    );
  }

  return (
    <div className="w-full flex-1 max-w-[1400px] mx-auto text-slate-900 font-sans flex flex-col p-4 sm:p-6 lg:p-6 gap-6 min-h-screen overflow-x-hidden">
      {/* Header Section */}
      <header className="flex flex-col sm:flex-row justify-between items-start sm:items-center bg-white p-5 rounded-2xl border border-slate-200 shadow-sm shrink-0">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center text-white shadow-lg shadow-indigo-100">
            <Globe className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight">Sincro Scheduler</h1>
            <p className="text-xs text-slate-500 uppercase tracking-widest font-semibold">Global Recruiting Edition</p>
          </div>
        </div>
        <div className="flex items-center gap-4 mt-4 sm:mt-0">
          <div className="flex flex-col items-end">
            <span className="text-sm font-medium">{user?.email}</span>
            <span className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Organizer</span>
          </div>
          <div className="flex items-center gap-3">
             <button onClick={handleLogout} className="text-slate-500 hover:text-slate-900 transition-colors text-xs font-medium px-4 py-2.5 bg-slate-50 rounded-full hover:bg-slate-100 border border-slate-200">Sign out</button>
             <button 
                onClick={handleCreateInvite}
                disabled={isCreatingEvent || !selectedTime}
                className="bg-indigo-600 text-white px-6 py-2.5 rounded-full font-medium text-sm hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-200 disabled:opacity-50 disabled:shadow-none whitespace-nowrap hidden sm:block"
             >
                {isCreatingEvent ? 'Creating...' : 'Create Invite'}
             </button>
          </div>
        </div>
      </header>

      {/* Main Bento Grid */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-4 lg:grid-rows-[minmax(0,1fr)_auto]">
        
        {/* Attendee Tracker Card */}
        <div className="lg:col-span-4 lg:row-span-1 border border-slate-200 p-6 shadow-sm flex flex-col h-full bg-white rounded-3xl overflow-hidden min-h-[400px]">
          <div className="flex justify-between items-center mb-6 shrink-0">
            <h2 className="font-bold text-lg text-slate-900">Attendees</h2>
            <span className="px-2 py-1 bg-slate-100 text-slate-600 text-[10px] font-bold rounded uppercase">{attendees.length} Person{attendees.length !== 1 && 's'}</span>
          </div>
          <div className="space-y-4 flex-1 overflow-y-auto pr-2 pb-2">
                {attendees.map((attendee, index) => (
                  <div key={attendee.id} className="flex flex-col gap-3 p-4 rounded-2xl bg-white border border-slate-100 shadow-sm relative">
                    <div className="flex items-center gap-3 w-full">
                       <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center text-xs font-bold text-indigo-700 shrink-0">{index === 0 ? 'Org' : 'Gst'}</div>
                       <div className="flex-1 min-w-0 pr-6">
                         <input type="text" value={attendee.email} onChange={e => updateAttendee(attendee.id, 'email', e.target.value)} placeholder="Email address" className="w-full text-sm font-semibold bg-transparent border-none p-0 focus:ring-0 text-slate-900 placeholder-slate-400 outline-none" />
                         <select value={attendee.timeZone} onChange={e => updateAttendee(attendee.id, 'timeZone', e.target.value)} className="w-[105%] text-[10px] text-slate-500 bg-transparent border-none p-0 focus:ring-0 outline-none cursor-pointer mt-1 truncate block">
                           {COMMON_TIMEZONES.map(tz => (
                             <option key={tz.value} value={tz.value}>{tz.label}</option>
                           ))}
                         </select>
                       </div>
                    </div>
                    <div className="flex items-center justify-between border-t border-slate-100 pt-3 mt-1">
                       <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Working Hours</span>
                       <div className="flex items-center gap-1">
                          <select value={attendee.workStart} onChange={e => updateAttendee(attendee.id, 'workStart', Number(e.target.value))} className="text-xs font-mono bg-slate-50 border border-slate-200 rounded px-1 py-0.5 focus:border-indigo-500 outline-none cursor-pointer text-slate-700">
                            {Array.from({length: 24}).map((_, i) => <option key={`start-${i}`} value={i}>{i.toString().padStart(2, '0')}:00</option>)}
                          </select>
                          <span className="text-slate-400 text-xs">-</span>
                          <select value={attendee.workEnd} onChange={e => updateAttendee(attendee.id, 'workEnd', Number(e.target.value))} className="text-xs font-mono bg-slate-50 border border-slate-200 rounded px-1 py-0.5 focus:border-indigo-500 outline-none cursor-pointer text-slate-700">
                            {Array.from({length: 24}).map((_, i) => <option key={`end-${i}`} value={i}>{i.toString().padStart(2, '0')}:00</option>)}
                          </select>
                       </div>
                    </div>
                    {attendees.length > 1 && (
                      <button onClick={() => removeAttendee(attendee.id)} className="absolute top-4 right-4 p-1 text-slate-300 hover:text-red-500 transition-colors rounded-full hover:bg-red-50">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                ))}
          </div>
          <div className="shrink-0 pt-4 bg-white">
             <button onClick={addAttendee} className="w-full py-3 border-2 border-dashed border-slate-200 text-slate-400 text-sm font-medium rounded-2xl hover:border-indigo-300 hover:text-indigo-500 transition-colors bg-slate-50/50">+ Add Attendee</button>
             <button onClick={calculateOverlaps} className="mt-3 w-full bg-slate-900 hover:bg-slate-800 text-white px-5 py-3.5 rounded-2xl font-medium text-sm shadow-md transition-colors flex justify-center items-center gap-2">
                <Play className="w-4 h-4 fill-current" />
                Find Best Times
             </button>
          </div>
        </div>

        {/* Suggestion Engine Card */}
        <div className="lg:col-span-8 lg:row-span-1 bg-indigo-900 rounded-3xl p-6 sm:p-8 text-white relative overflow-hidden shadow-xl flex flex-col min-h-[400px]">
          {/* Decorative element */}
          <div className="absolute -bottom-20 -right-20 w-80 h-80 bg-indigo-500/20 rounded-full blur-3xl pointer-events-none"></div>
          
          <div className="relative z-10 flex-1 flex flex-col">
            <div className="flex justify-between items-start mb-8 shrink-0">
              <div>
                <h2 className="text-2xl font-bold mb-1 tracking-tight">Best Overlap Times</h2>
                <p className="text-indigo-200 text-sm">Optimized for {duration} min duration on {format(parseISO(dateStr), 'MMM d, yyyy')}</p>
              </div>
              <div className="bg-indigo-800 px-4 py-2 rounded-xl border border-indigo-700 hidden sm:block shadow-inner">
                <span className="text-[10px] font-bold text-indigo-300 uppercase tracking-wider">Sync Results</span>
              </div>
            </div>
            
            <div className="flex-1 flex flex-col">
              {step === 1 ? (
                <div className="flex-1 flex flex-col items-center justify-center text-center text-indigo-300/60 p-4">
                   <div className="w-16 h-16 rounded-full bg-indigo-800/30 flex items-center justify-center mb-6">
                      <Clock className="w-8 h-8 opacity-70" />
                   </div>
                   <p className="text-sm font-medium tracking-wide max-w-[280px]">Add attendees and click &quot;Find Best Times&quot; to discover perfect overlapping slots.</p>
                </div>
              ) : step === 2 ? (
                  suggestedTimes.length === 0 ? (
                    <div className="flex-1 flex flex-col items-center justify-center text-center p-8 bg-indigo-950/40 rounded-2xl border border-indigo-800/50">
                      <AlertCircle className="w-10 h-10 mb-4 text-orange-400 opacity-90" />
                      <p className="text-base font-bold text-orange-100">No perfect overlap found</p>
                      <p className="text-sm mt-2 text-indigo-300">Try adjusting working hours or date.</p>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 auto-rows-max overflow-y-auto pr-2 pb-2 flex-1 content-start">
                      {suggestedTimes.map((opt, idx) => {
                         const tzBase = attendees[0].timeZone;
                         const hasViolation = opt.violations.length > 0;
                         const isSelected = selectedTime === opt.time;
                         
                         let cardClass = isSelected
                           ? "bg-white rounded-2xl p-5 text-slate-900 ring-4 ring-indigo-500/50 relative shadow-lg transform transition-all scale-[1.02]"
                           : "bg-indigo-800/50 rounded-2xl p-5 border border-indigo-700 hover:bg-indigo-800 transition-all cursor-pointer group relative";
                         
                         if (hasViolation && !isSelected) {
                            cardClass = "bg-rose-950/40 rounded-2xl p-5 border border-rose-900/50 hover:bg-rose-900/40 transition-all cursor-pointer group relative";
                         } else if (hasViolation && isSelected) {
                            cardClass = "bg-white rounded-2xl p-5 text-slate-900 ring-4 ring-rose-500/50 relative shadow-lg transform transition-all scale-[1.02]";
                         }

                         return (
                           <div key={opt.time.toISOString()} onClick={() => setSelectedTimeWrapper(opt)} className={cardClass}>
                             {idx === 0 && (
                               <div className="absolute -top-3 left-4 bg-emerald-500 text-white text-[10px] px-2 py-1 rounded font-bold uppercase shadow-sm tracking-wide">Top Match</div>
                             )}
                             {hasViolation && idx !== 0 && (
                               <div className="absolute -top-3 left-4 bg-rose-500 text-white text-[10px] px-2 py-1 rounded font-bold uppercase shadow-sm tracking-wide">Conflict</div>
                             )}
                             <div className={`text-3xl font-black mb-1 tracking-tighter ${!isSelected && 'opacity-80 group-hover:opacity-100'} ${hasViolation && isSelected ? 'text-rose-600' : ''}`}>
                               {formatInTimeZone(opt.time, tzBase, 'HH:mm')}
                             </div>
                             <div className={`text-[10px] font-bold ${isSelected ? 'text-slate-400' : 'text-indigo-400'} mb-4 uppercase tracking-wider truncate`}>
                               {COMMON_TIMEZONES.find(t => t.value === tzBase)?.label.split(' ')[0] || tzBase} Time
                             </div>
                             
                             <div className={`space-y-2 border-t pt-3 ${isSelected ? 'border-slate-100' : 'border-indigo-700 opacity-60 group-hover:opacity-100 transition-opacity'}`}>
                               {attendees.slice(1, 4).map(a => {
                                 const aLocal = formatInTimeZone(opt.time, a.timeZone, 'h:mm a');
                                 const aName = (a.email.split('@')[0] || a.name || 'Gst').substring(0, 10);
                                 const isViolating = opt.violations.includes(a.email || a.name || 'someone');
                                 
                                 return (
                                   <div key={a.id} className={`flex justify-between text-[11px] ${isViolating ? (isSelected ? 'text-rose-600 font-bold' : 'text-rose-400 font-bold') : ''}`}>
                                     <span className={isSelected && !isViolating ? 'text-slate-500' : ''}>{aName}</span>
                                     <span className={isSelected ? 'font-bold' : 'font-medium'}>{aLocal}</span>
                                   </div>
                                 );
                               })}
                               {attendees.length > 4 && (
                                 <div className="text-[10px] text-center italic mt-2 opacity-70">+{attendees.length - 4} more</div>
                               )}
                             </div>
                           </div>
                         );
                      })}
                    </div>
                  )
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center text-center px-4 py-8 relative">
                   <div className="absolute inset-0 bg-indigo-950/60 rounded-2xl border border-indigo-800/50 backdrop-blur-sm shadow-inner flex flex-col items-center justify-center z-10 p-6">
                      <div className="w-16 h-16 bg-emerald-500/20 text-emerald-400 rounded-full flex items-center justify-center mb-6 ring-1 ring-emerald-500/50 shadow-inner">
                        <CheckCircle2 className="w-8 h-8" />
                      </div>
                      <h3 className="font-bold text-white text-2xl mb-2 tracking-tight">Invite Created!</h3>
                      <p className="text-sm text-indigo-200 mb-8 max-w-[280px]">The event has been securely drafted in your Google Calendar ({user?.email}).</p>
                      
                      <div className="flex flex-col sm:flex-row gap-3 w-full sm:w-auto">
                        {createdEventLink && (
                          <a href={createdEventLink} target="_blank" rel="noreferrer" className="bg-white text-indigo-900 px-8 py-3 rounded-full font-bold text-sm shadow-lg hover:bg-slate-50 transition-colors">
                            Open Calendar
                          </a>
                        )}
                        <button onClick={() => { setStep(1); setSuggestedTimes([]); setSelectedTimeWrapper(null); }} className="px-8 py-3 rounded-full font-bold text-sm text-indigo-200 hover:text-white hover:bg-indigo-800 transition-colors border border-transparent hover:border-indigo-700">
                          Create Another Sync
                        </button>
                      </div>
                   </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Meeting Details Card */}
        <div className="lg:col-span-8 lg:col-start-5 bg-white rounded-3xl border border-slate-200 p-6 shadow-sm">
           <h3 className="font-bold text-base leading-tight mb-5 text-slate-900">Meeting Details</h3>
           <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
              <div className="col-span-1 lg:col-span-2">
                 <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 pl-1">Event Title</label>
                 <input type="text" value={title} onChange={e => setTitle(e.target.value)} className="w-full text-sm font-semibold bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none text-slate-900 transition-all" placeholder="e.g. Design Review" />
              </div>
              <div className="col-span-1">
                 <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 pl-1">Date Target</label>
                 <input type="date" value={dateStr} onChange={e => setDateStr(e.target.value)} className="w-full text-sm font-semibold bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none text-slate-900 cursor-pointer transition-all" />
              </div>
              <div className="col-span-1">
                 <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 pl-1">Duration</label>
                 <select value={duration} onChange={e => setDuration(Number(e.target.value))} className="w-full text-sm font-semibold bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none text-slate-900 cursor-pointer transition-all">
                    <option value={15}>15 Minutes</option>
                    <option value={30}>30 Minutes</option>
                    <option value={45}>45 Minutes</option>
                    <option value={60}>1 Hour</option>
                    <option value={90}>1.5 Hours</option>
                 </select>
              </div>
              <div className="col-span-1 lg:col-span-4">
                 <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 pl-1">Agenda / Notes</label>
                 <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2} className="w-full text-sm font-medium bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none text-slate-700 line-clamp-3 transition-all" placeholder="Optional description..."></textarea>
                 
                 <label className="flex items-center gap-3 text-xs font-medium cursor-pointer mt-4 w-fit group">
                    <div className="relative flex items-center justify-center">
                       <input type="checkbox" checked={addMeetLink} onChange={e => setAddMeetLink(e.target.checked)} className="peer sr-only" />
                       <div className="w-5 h-5 rounded-[4px] border-2 border-slate-300 bg-slate-50 peer-checked:bg-indigo-50 peer-checked:border-indigo-500 flex items-center justify-center transition-all">
                          <div className={`w-2.5 h-2.5 rounded-sm bg-indigo-600 transition-transform ${addMeetLink ? 'scale-100 opacity-100' : 'scale-0 opacity-0'}`}></div>
                       </div>
                    </div>
                    <span className="text-slate-600 group-hover:text-slate-900 transition-colors select-none">Generate Google Meet Link</span>
                 </label>
              </div>
           </div>
        </div>
      </div>
    </div>
  );
}
